/**
 * OpenAPI 3.1 contract — machine-readable API surface.
 *
 * Single source of truth for API endpoints, schemas, and security requirements.
 * This contract serves as:
 * 1. API documentation
 * 2. Breaking-change detection in CI
 * 3. Client generation input
 */

export interface OpenAPIPathItem {
  summary: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;
}

export interface OpenAPIParameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  schema: { type: string; enum?: string[] };
}

export interface OpenAPIRequestBody {
  required?: boolean;
  content: Record<string, { schema: Record<string, unknown> }>;
}

export interface OpenAPIResponse {
  description: string;
  content?: Record<string, { schema: Record<string, unknown> }>;
}

export const OPENAPI_CONTRACT: Record<string, OpenAPIPathItem> = {
  '/auth/login': {
    summary: 'Authenticate user',
    security: [],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 8 },
            },
            required: ['email', 'password'],
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Authentication successful',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                token: { type: 'string' },
                refresh_token: { type: 'string' },
                expires_in: { type: 'integer' },
                user: { type: 'object' },
              },
            },
          },
        },
      },
      '401': { description: 'Invalid credentials' },
    },
  },

  '/tasks': {
    summary: 'List tasks',
    security: [{ bearerAuth: [] }],
    parameters: [
      { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] } },
    ],
    responses: {
      '200': {
        description: 'Task list',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { tasks: { type: 'array' } } },
          },
        },
      },
      '401': { description: 'Authentication required' },
      '403': { description: 'Insufficient permissions' },
    },
  },

  '/tasks/{id}/execute': {
    summary: 'Execute a task',
    security: [{ bearerAuth: [] }],
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ],
    responses: {
      '200': { description: 'Execution started' },
      '403': { description: 'Forbidden — missing execute:task permission' },
      '409': { description: 'Awaiting approval' },
      '422': { description: 'Denied by policy' },
    },
  },

  '/approvals/{id}/approve': {
    summary: 'Approve a pending request',
    description: 'SECURITY: Self-approval is forbidden (409). The maker cannot be the approver.',
    security: [{ bearerAuth: [] }],
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
    },
    responses: {
      '200': { description: 'Approval granted' },
      '403': { description: 'Forbidden — missing approve:task permission' },
      '409': { description: 'Self-approval forbidden' },
      '404': { description: 'Approval not found' },
      '422': { description: 'Approval already processed' },
    },
  },

  '/sbom/generate': {
    summary: 'Generate CycloneDX SBOM',
    security: [{ bearerAuth: [] }],
    responses: {
      '200': {
        description: 'CycloneDX SBOM JSON',
        content: {
          'application/json': {
            schema: { type: 'object' },
          },
        },
      },
      '403': { description: 'Forbidden — missing read:evidence permission' },
    },
  },

  '/self-modification/execute': {
    summary: 'Self-modification execute (DISABLED)',
    description: 'Returns 451 Unavailable. Self-modification via API is blocked for security.',
    security: [{ bearerAuth: [] }],
    responses: {
      '451': { description: 'Unavailable — self-modification disabled' },
    },
  },
};

export const API_VERSION = '1.0.0';
export const API_TITLE = 'DjimFlo Control Plane API';
export const API_SECURITY_SCHEMES = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  },
};
