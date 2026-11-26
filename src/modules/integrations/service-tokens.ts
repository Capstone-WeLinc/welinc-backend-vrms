import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSERTION_SIGNER,
  AssertionSigner,
  ServiceTokenClient,
  VERIFY_CONFIG,
  type VerifyConfig,
} from '../../auth/verify';

/**
 * Spec 0029: VRMS's own service tokens for VMMS and BMS, one client per audience and scope, made
 * the first time it is asked for and kept for the life of the process (each caches its token).
 */
@Injectable()
export class ServiceTokens {
  private readonly logger = new Logger('ServiceToken');
  private readonly clients = new Map<string, ServiceTokenClient>();

  constructor(
    @Inject(VERIFY_CONFIG) private readonly verify: VerifyConfig,
    @Inject(ASSERTION_SIGNER) private readonly signer: AssertionSigner,
  ) {}

  for(audience: string, scope: string): ServiceTokenClient {
    const key = `${audience} ${scope}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new ServiceTokenClient({
        tokenUrl: `${this.verify.internalUrl}/auth/token`,
        signer: this.signer,
        audience,
        scope,
        onError: (reason) =>
          this.logger.warn(
            `could not get a ${audience} ${scope} token: ${reason}`,
          ),
      });
      this.clients.set(key, client);
    }
    return client;
  }
}
