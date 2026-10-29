import { describe, it, expect, beforeEach } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PermissionsService } from './auth/permissions/permissions.service';

describe('AppController', () => {
  let appController: AppController;
  const permissions = { isReady: true };

  beforeEach(async () => {
    permissions.isReady = true;
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: PermissionsService, useValue: permissions },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('answers 503 until the permission matrix has loaded', () => {
      permissions.isReady = false;

      expect(() => appController.getHello()).toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
