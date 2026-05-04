// Uses jest.resetModules() + require() per test to reset the module-level cachedClient.

type CfService = typeof import('../../services/cloudflare');

interface MockCfInstance {
  zones: { list: jest.Mock };
  dns: {
    records: {
      list: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
}

let cfService: CfService;
let mockCfInstance: MockCfInstance;
let mockSmSend: jest.Mock;
let MockCloudflareCtor: jest.Mock;
let MockAPIError: new (status: number, name: string, message: string) => Error;

// Helper: wraps items in an async iterable to simulate SDK's for-await pagination.
function asyncIterable<T>(...items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* items;
    },
  };
}

beforeEach(() => {
  mockCfInstance = {
    zones: { list: jest.fn() },
    dns: {
      records: {
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    },
  };

  mockSmSend = jest
    .fn()
    .mockResolvedValue({ SecretString: '{"token":"test-token"}' });

  class APIError extends Error {
    status: number;
    constructor(status: number, name: string, message: string) {
      super(message);
      this.name = name;
      this.status = status;
    }
  }
  MockAPIError = APIError;

  MockCloudflareCtor = jest.fn(() => mockCfInstance);
  (MockCloudflareCtor as unknown as Record<string, unknown>).APIError = APIError;

  jest.resetModules();
  jest.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockSmSend })),
    GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  }));
  jest.mock('cloudflare', () => ({
    default: MockCloudflareCtor,
    __esModule: true,
  }));

  process.env.SECRET_NAME = 'test-secret-name';
  cfService = require('../../services/cloudflare') as CfService;
});

afterEach(() => {
  delete process.env.SECRET_NAME;
});

describe('findZone', () => {
  it('returns zone ID for an exact domain match', async () => {
    mockCfInstance.zones.list.mockReturnValue(
      asyncIterable({ id: 'zone-abc', name: 'example.com' }),
    );

    const result = await cfService.findZone('example.com');

    expect(result).toBe('zone-abc');
  });

  it('walks toward the apex to find the zone for a subdomain', async () => {
    mockCfInstance.zones.list
      .mockReturnValueOnce(asyncIterable()) // no zone for full hostname
      .mockReturnValueOnce(asyncIterable({ id: 'zone-apex', name: 'example.com' }));

    const result = await cfService.findZone('sub.example.com');

    expect(result).toBe('zone-apex');
    expect(mockCfInstance.zones.list).toHaveBeenCalledTimes(2);
  });

  it('strips trailing dot before zone lookup (ACM appends trailing dots)', async () => {
    mockCfInstance.zones.list.mockReturnValue(
      asyncIterable({ id: 'zone-apex', name: 'example.com' }),
    );

    const result = await cfService.findZone('_abc.example.com.');

    expect(result).toBe('zone-apex');
  });

  it('throws when no matching zone is found', async () => {
    mockCfInstance.zones.list.mockReturnValue(asyncIterable());

    await expect(cfService.findZone('unknown.example.com')).rejects.toThrow(
      'No CloudFlare zone found for domain: unknown.example.com',
    );
  });
});

describe('upsertCnameRecord', () => {
  it('creates a new record when none exists', async () => {
    mockCfInstance.dns.records.list.mockReturnValue(asyncIterable()); // no existing record
    mockCfInstance.dns.records.create.mockResolvedValue({});

    await cfService.upsertCnameRecord('zone-1', '_abc.example.com', '_def.acm-validations.aws');

    expect(mockCfInstance.dns.records.create).toHaveBeenCalledWith({
      zone_id: 'zone-1',
      type: 'CNAME',
      name: '_abc.example.com',
      content: '_def.acm-validations.aws',
      ttl: 1,
    });
    expect(mockCfInstance.dns.records.update).not.toHaveBeenCalled();
  });

  it('updates an existing record when one already exists', async () => {
    mockCfInstance.dns.records.list.mockReturnValue(
      asyncIterable({ id: 'existing-id', name: '_abc.example.com' }),
    );
    mockCfInstance.dns.records.update.mockResolvedValue({});

    await cfService.upsertCnameRecord('zone-1', '_abc.example.com', '_new.acm-validations.aws');

    expect(mockCfInstance.dns.records.update).toHaveBeenCalledWith('existing-id', {
      zone_id: 'zone-1',
      type: 'CNAME',
      name: '_abc.example.com',
      content: '_new.acm-validations.aws',
      ttl: 1,
    });
    expect(mockCfInstance.dns.records.create).not.toHaveBeenCalled();
  });

  it('strips trailing dots from name and value', async () => {
    mockCfInstance.dns.records.list.mockReturnValue(asyncIterable());
    mockCfInstance.dns.records.create.mockResolvedValue({});

    await cfService.upsertCnameRecord(
      'zone-1',
      '_abc.example.com.',
      '_def.acm-validations.aws.',
    );

    expect(mockCfInstance.dns.records.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '_abc.example.com',
        content: '_def.acm-validations.aws',
      }),
    );
  });
});

describe('listAllZoneIds', () => {
  it('returns all zone IDs', async () => {
    mockCfInstance.zones.list.mockReturnValue(
      asyncIterable({ id: 'zone-1' }, { id: 'zone-2' }, { id: 'zone-3' }),
    );

    const result = await cfService.listAllZoneIds();

    expect(result).toEqual(['zone-1', 'zone-2', 'zone-3']);
  });

  it('returns an empty array when no zones exist', async () => {
    mockCfInstance.zones.list.mockReturnValue(asyncIterable());

    const result = await cfService.listAllZoneIds();

    expect(result).toEqual([]);
  });
});

describe('listAcmValidationCnames', () => {
  it('returns only records whose content ends with .acm-validations.aws', async () => {
    mockCfInstance.dns.records.list.mockReturnValue(
      asyncIterable(
        { id: 'rec-1', name: '_abc.example.com', content: '_xyz.acm-validations.aws' },
        { id: 'rec-2', name: 'www.example.com', content: 'target.example.com' },
        { id: 'rec-3', name: '_def.example.com', content: '_uvw.acm-validations.aws' },
      ),
    );

    const result = await cfService.listAcmValidationCnames('zone-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'rec-1', name: '_abc.example.com', content: '_xyz.acm-validations.aws' });
    expect(result[1]).toEqual({ id: 'rec-3', name: '_def.example.com', content: '_uvw.acm-validations.aws' });
  });

  it('returns an empty array when no ACM validation records exist', async () => {
    mockCfInstance.dns.records.list.mockReturnValue(asyncIterable());

    const result = await cfService.listAcmValidationCnames('zone-1');

    expect(result).toEqual([]);
  });
});

describe('deleteCnameRecord', () => {
  it('calls the delete API with the correct parameters', async () => {
    mockCfInstance.dns.records.delete.mockResolvedValue({});

    await cfService.deleteCnameRecord('zone-1', 'record-id-1');

    expect(mockCfInstance.dns.records.delete).toHaveBeenCalledWith('record-id-1', {
      zone_id: 'zone-1',
    });
  });

  it('wraps CloudFlare APIError with structured message', async () => {
    const apiError = new MockAPIError(404, 'NotFoundError', 'DNS record not found');
    mockCfInstance.dns.records.delete.mockRejectedValue(apiError);

    await expect(cfService.deleteCnameRecord('zone-1', 'record-id-1')).rejects.toThrow(
      'CloudFlare API error during "delete record record-id-1": status=404 name=NotFoundError message=DNS record not found',
    );
  });
});
