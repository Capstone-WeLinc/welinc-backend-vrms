import { createHash } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  UserDelegationKey,
} from '@azure/storage-blob';
import {
  contentDisposition,
  FileStore,
  LINK_CACHE_CONTROL,
  ListedBlob,
  linkWindow,
  StorageUnavailableException,
  StoredFile,
} from './file-store';

const HOUR = 60 * 60 * 1000;

type Signer =
  | { kind: 'sharedKey'; credential: StorageSharedKeyCredential }
  | { kind: 'delegation' };

/** The connection string, the account URL, or neither (AC-3). Read once at startup. */
export function storageConfig(env: NodeJS.ProcessEnv = process.env) {
  const connectionString = env.STORAGE_CONNECTION_STRING?.trim() || undefined;
  const accountUrl = env.STORAGE_ACCOUNT_URL?.trim() || undefined;
  return {
    connectionString,
    accountUrl: connectionString ? undefined : accountUrl,
    bothSet: Boolean(connectionString && accountUrl),
    container: env.STORAGE_CONTAINER?.trim() || 'vrms-attachments',
    publicUrl: env.STORAGE_PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
  };
}

/** The link the browser opens: the public host (if set), the container, the key and the SAS. */
export function blobLink(
  host: string,
  container: string,
  key: string,
  sas: string,
): string {
  return `${host.replace(/\/+$/, '')}/${container}/${key}?${sas}`;
}

// Spec 0017: the Azure Blob Storage FileStore. Locally Azurite, signed with its shared key;
// in Azure the managed identity, signed with a user delegation key.
@Injectable()
export class BlobFileStore implements FileStore, OnModuleInit {
  private readonly logger = new Logger(BlobFileStore.name);
  private readonly service: BlobServiceClient | null;
  private readonly container: ContainerClient | null;
  private readonly signer: Signer | null;
  private readonly host: string;
  private readonly httpsOnly: boolean;
  private containerReady = false;
  private delegation: { key: UserDelegationKey; expiresOn: Date } | null = null;

  readonly configured: boolean;

  constructor() {
    const config = storageConfig();
    if (config.bothSet) {
      this.logger.warn(
        'Both STORAGE_CONNECTION_STRING and STORAGE_ACCOUNT_URL are set; using the connection string',
      );
    }

    if (config.connectionString) {
      this.service = BlobServiceClient.fromConnectionString(
        config.connectionString,
      );
      const credential = this.service.credential;
      this.signer =
        credential instanceof StorageSharedKeyCredential
          ? { kind: 'sharedKey', credential }
          : null;
      this.httpsOnly = false;
    } else if (config.accountUrl) {
      this.service = new BlobServiceClient(
        config.accountUrl,
        new DefaultAzureCredential(),
      );
      this.signer = { kind: 'delegation' };
      this.httpsOnly = true;
    } else {
      this.service = null;
      this.signer = null;
      this.httpsOnly = true;
    }

    this.configured = Boolean(this.service && this.signer);
    this.container = this.service?.getContainerClient(config.container) ?? null;
    this.host = config.publicUrl ?? this.service?.url ?? '';

    if (!this.configured) {
      this.logger.warn(
        'File storage is not configured: attachment routes answer 503 STORAGE_UNAVAILABLE',
      );
    }
  }

  async onModuleInit() {
    // Best effort: a role assignment can take minutes to apply, so never fatal
    if (this.configured) await this.ensureContainer();
  }

  async put(file: StoredFile): Promise<void> {
    const container = await this.ready();
    const md5 = createHash('md5').update(file.body).digest();
    await container
      .getBlockBlobClient(file.key)
      .upload(file.body, file.body.length, {
        blobHTTPHeaders: {
          blobContentType: file.contentType,
          blobContentDisposition: contentDisposition(file.fileName),
          blobCacheControl: LINK_CACHE_CONTROL,
        },
        // Azure checks the bytes on write and keeps the MD5
        transactionalContentMD5: md5,
      });
  }

  async delete(key: string): Promise<void> {
    const container = this.requireContainer();
    await container.getBlobClient(key).deleteIfExists();
  }

  async readUrl(
    key: string,
    fileName: string,
    contentType: string,
    now: Date = new Date(),
  ): Promise<string> {
    const container = this.requireContainer();
    const { startsOn, expiresOn } = linkWindow(now);
    const values = {
      containerName: container.containerName,
      blobName: key,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
      protocol: this.httpsOnly ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
      contentType,
      contentDisposition: contentDisposition(fileName),
      cacheControl: LINK_CACHE_CONTROL,
    };

    const sas =
      this.signer?.kind === 'sharedKey'
        ? generateBlobSASQueryParameters(values, this.signer.credential)
        : generateBlobSASQueryParameters(
            values,
            await this.delegationKey(now),
            this.service!.accountName,
          );

    return blobLink(this.host, container.containerName, key, sas.toString());
  }

  async *list(prefix: string): AsyncIterable<ListedBlob> {
    const container = this.requireContainer();
    for await (const blob of container.listBlobsFlat({ prefix })) {
      yield { name: blob.name, createdOn: blob.properties.createdOn };
    }
  }

  /** AC-2: requested from now minus 15 minutes to now plus 24 hours, renewed under 1 hour left. */
  private async delegationKey(now: Date): Promise<UserDelegationKey> {
    if (
      this.delegation &&
      this.delegation.expiresOn.getTime() - now.getTime() > HOUR
    ) {
      return this.delegation.key;
    }
    const startsOn = new Date(now.getTime() - 15 * 60 * 1000);
    const expiresOn = new Date(now.getTime() + 24 * HOUR);
    const key = await this.service!.getUserDelegationKey(startsOn, expiresOn);
    this.delegation = { key, expiresOn };
    return key;
  }

  private requireContainer(): ContainerClient {
    if (!this.configured || !this.container) {
      throw new StorageUnavailableException();
    }
    return this.container;
  }

  private async ready(): Promise<ContainerClient> {
    const container = this.requireContainer();
    if (!this.containerReady) await this.ensureContainer();
    return container;
  }

  private async ensureContainer() {
    try {
      // Private: no access level means no public read
      await this.container!.createIfNotExists();
      this.containerReady = true;
    } catch (error) {
      this.logger.warn(
        `Could not create the storage container yet; trying again on first use: ${String(error)}`,
      );
    }
  }
}
