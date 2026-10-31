import { PERMISSION_KEY } from '../../auth/permissions/permission.decorators';
import { AnalyticsController } from '../analytics/analytics.controller';
import { AiController } from './ai.controller';

// Spec 0013, AC-1 and AC-17: the permission on each route is the boundary. A route with none
// is denied, so a missing or wrong key here is a real hole.
function keysOf(proto: object, method: string): string[] | undefined {
  const handler = (proto as Record<string, object>)[method];
  return Reflect.getMetadata(PERMISSION_KEY, handler) as string[] | undefined;
}

function handlersOf(proto: object) {
  return Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
}

describe('AiController route permissions', () => {
  const proto = AiController.prototype;

  it.each(['run', 'latest', 'feedback'])('%s needs ai.use', (method) => {
    expect(keysOf(proto, method)).toEqual(['ai.use']);
  });

  it('stats is opened by analytics.view because it shows on the Analytics page', () => {
    expect(keysOf(proto, 'stats')).toEqual(['analytics.view']);
  });

  it('every handler declares a permission', () => {
    for (const name of handlersOf(proto)) {
      expect(keysOf(proto, name)).toBeDefined();
    }
  });
});

describe('AiController delegation', () => {
  const diagnoses = {
    run: jest.fn().mockResolvedValue('ran'),
    latest: jest.fn().mockResolvedValue('latest'),
    saveFeedback: jest.fn().mockResolvedValue('saved'),
    stats: jest.fn().mockResolvedValue('stats'),
  };
  const controller = new AiController(diagnoses as never);
  const user = { sub: 'u1' } as never;
  const ability = {} as never;

  it('passes the ticket, the caller and the ability to run', async () => {
    await expect(controller.run('t1', { user }, ability)).resolves.toBe('ran');
    expect(diagnoses.run).toHaveBeenCalledWith('t1', user, ability);
  });

  it('passes the ticket and ability to latest', async () => {
    await controller.latest('t1', ability);
    expect(diagnoses.latest).toHaveBeenCalledWith('t1', ability);
  });

  it('passes the id, body, caller and ability to feedback', async () => {
    const dto = { rating: 5 } as never;
    await controller.feedback('d1', dto, { user }, ability);
    expect(diagnoses.saveFeedback).toHaveBeenCalledWith(
      'd1',
      dto,
      user,
      ability,
    );
  });
});

describe('AnalyticsController route permissions', () => {
  const proto = AnalyticsController.prototype;
  const handlers = handlersOf(proto);

  it('serves the eight analytics routes', () => {
    expect([...handlers].sort()).toEqual([
      'aging',
      'costTrends',
      'garageCosts',
      'issueFrequency',
      'statusBreakdown',
      'summary',
      'vehicleKpis',
      'velocity',
    ]);
  });

  it.each(handlers)('%s needs analytics.view', (method) => {
    expect(keysOf(proto, method)).toEqual(['analytics.view']);
  });
});
