import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ChecklistEditsService } from '../modules/vrms/checklist-edits.service';
import { RepairsController } from '../modules/vrms/repairs.controller';
import { RepairsService } from '../modules/vrms/repairs.service';
import { TicketEditsService } from '../modules/vrms/ticket-edits.service';
import { expectReplyMatches } from './expect-reply';

// covers: VRMS spec 0026 AC-6. The four ticket routes of AC-5 run through a testing module with the
// real RepairsController (no guards: the global ones aren't in the module, and a middleware sets
// what they would), its services faked with replies shaped like RepairsService.formatTicket and
// present, and each reply must match the route's schema in the committed docs/openapi.json.

const ID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const ISSUE_ID = '7a2b3c4d-5e6f-4a70-8b81-a2b3c4d5e6f8';
const ISO = '2026-11-16T08:00:00.000Z';

const STEP = {
  id: '8b3c4d5e-6f70-4b81-9c92-b3c4d5e6f7a9',
  position: 1,
  text: 'Check the brake pads for wear',
  checkedAt: ISO,
  checkedByEmail: 'mechanic@welinc.com',
  origin: 'KNOWN_FIX',
  editedAt: null,
};

const ISSUE = {
  id: ISSUE_ID,
  description: '[Brakes] Worn pads: Grinding noise when braking',
  categoryId: ID,
  categoryName: 'Brakes',
  knowledgeEntry: {
    id: ID,
    name: 'Replace brake pads',
    categoryId: ID,
    status: 'ACTIVE',
    safetyNotes: 'Chock the wheels first',
    parts: ['Brake pad set'],
    typicalHours: 1.5,
    estimatedHours: 2,
  },
  checklistVersion: 0,
  steps: [STEP],
  resolutionNote: null,
  hoursSpent: null,
  followedKnownFix: null,
  resolvedAt: null,
};

/** A list row as `formatTicket` builds it for a caller who may not read costs. */
const ROW = {
  id: ID,
  repairNumber: 'REP-20261116-A1B2',
  status: 'IN_PROGRESS',
  vehiclePlate: 'ABC 1234',
  vehicleModel: 'Isuzu NQR',
  driverName: 'Juan Dela Cruz',
  driverId: ID,
  garageLocation: 'Main Garage',
  odometerReading: 120500,
  priority: 'HIGH',
  dueAt: ISO,
  dueAtSource: 'PRIORITY',
  reportedByName: 'VRMS Admin',
  accountType: 'ONLINE',
  corporation: null,
  verifiedByName: null,
  verifiedAt: null,
  editedAt: null,
  editedByName: null,
  issueDescription: '[Brakes] Worn pads: Grinding noise when braking',
  createdAt: ISO,
  updatedAt: ISO,
  lastActivityAt: ISO,
  statusChangedAt: ISO,
  closedAt: null,
  cancellationReason: null,
  remarks: null,
  issues: [ISSUE],
  mechanics: [{ id: ID, name: 'Pedro Santos' }],
  mechanicCount: 1,
  partsCost: null,
  laborCost: null,
  totalCost: null,
  hasInactiveMechanic: false,
  needsMechanic: false,
  can: {
    work: true,
    administer: false,
    verify: false,
    editCosts: false,
    unlock: false,
    assign: false,
    edit: false,
    editChecklist: true,
  },
};

/** `formatTicket` for a caller who may read the total cost: the cost record follows. */
const COSTED = {
  ...ROW,
  partsCost: 1500,
  laborCost: 800,
  totalCost: 2300,
  isLumpSum: false,
  isUnlocked: false,
  unlockReason: null,
  driverIsVerified: true,
  repairParts: [
    {
      id: ID,
      description: 'Brake pad set',
      unitCost: 750,
      quantity: 2,
      subtotal: 1500,
    },
  ],
};

/** `present`: one ticket in full. */
const DETAIL = {
  ...COSTED,
  moves: [
    {
      to: 'FOR_VERIFICATION',
      label: 'Send for verification',
      kind: 'forward',
      needs: 'resolutions',
      blockedBy: 'afterPhoto',
    },
    {
      to: 'ON_HOLD',
      label: 'Put on hold',
      kind: 'back',
      needs: 'remarks',
      blockedBy: null,
    },
  ],
  lastRejection: {
    remarks: 'Pads still squeak',
    byName: 'Chief Mechanic',
    at: ISO,
  },
  workStartedAt: ISO,
};

/** The same ticket for a mechanic: no cost record, no known fix, nothing sent back yet. */
const DETAIL_PLAIN = {
  ...ROW,
  issues: [
    { ...ISSUE, knowledgeEntry: null, categoryId: null, categoryName: null },
  ],
  moves: [],
  lastRejection: null,
  workStartedAt: null,
};

const CREATE_BODY = {
  vehiclePlate: 'ABC 1234',
  driverId: ID,
  accountType: 'ONLINE',
  garageLocation: 'Main Garage',
  odometerReading: 120500,
  priority: 'HIGH',
  issues: [
    {
      categoryId: ID,
      rootCause: 'Worn pads',
      description: 'Grinding noise when braking',
    },
  ],
};

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The controller in a testing module, with the real app's strict pipe. */
async function start(
  repairs: Partial<Record<keyof RepairsService, jest.Mock>>,
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RepairsController],
    providers: [
      { provide: RepairsService, useValue: repairs },
      { provide: TicketEditsService, useValue: {} },
      { provide: ChecklistEditsService, useValue: {} },
    ],
  }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>();
  // What JwtAuthGuard and PermissionsGuard set; the fake services never read them
  nest.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { user: { sub: ID }, ability: {} });
    next();
  });
  nest.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  await nest.init();
  app = nest;
  return request(nest.getHttpServer());
}

describe('the ticket replies match docs/openapi.json', () => {
  it('POST /vrms/repairs', async () => {
    const http = await start({ create: jest.fn().mockResolvedValue(DETAIL) });
    const res = await http.post('/vrms/repairs').send(CREATE_BODY).expect(201);
    expectReplyMatches(res.body, 'POST /vrms/repairs', 201);
  });

  it('GET /vrms/repairs', async () => {
    const http = await start({
      findAll: jest.fn().mockResolvedValue({ data: [ROW, COSTED], total: 2 }),
    });
    const res = await http.get('/vrms/repairs').expect(200);
    expectReplyMatches(res.body, 'GET /vrms/repairs', 200);
  });

  it('GET /vrms/repairs/:id, with the cost record', async () => {
    const http = await start({ findOne: jest.fn().mockResolvedValue(DETAIL) });
    const res = await http.get(`/vrms/repairs/${ID}`).expect(200);
    expectReplyMatches(res.body, 'GET /vrms/repairs/{id}', 200);
  });

  it('GET /vrms/repairs/:id, without the cost record and with the nulls', async () => {
    const http = await start({
      findOne: jest.fn().mockResolvedValue(DETAIL_PLAIN),
    });
    const res = await http.get(`/vrms/repairs/${ID}`).expect(200);
    expectReplyMatches(res.body, 'GET /vrms/repairs/{id}', 200);
  });

  it('PATCH /vrms/repairs/:id/status', async () => {
    const http = await start({
      updateStatus: jest.fn().mockResolvedValue(DETAIL),
    });
    const res = await http
      .patch(`/vrms/repairs/${ID}/status`)
      .send({ status: 'FOR_VERIFICATION', lastUpdatedAt: ISO })
      .expect(200);
    expectReplyMatches(res.body, 'PATCH /vrms/repairs/{id}/status', 200);
  });

  it('fails a reply field the schema does not name', async () => {
    const http = await start({
      findOne: jest.fn().mockResolvedValue({ ...DETAIL, secretField: 1 }),
    });
    const res = await http.get(`/vrms/repairs/${ID}`).expect(200);
    expect(() =>
      expectReplyMatches(res.body, 'GET /vrms/repairs/{id}', 200),
    ).toThrow('reply.secretField is not in the schema');
  });
});
