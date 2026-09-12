/**
 * OIDC Abstraction Layer — provider-agnostic authentication interface.
 *
 * Supports: Auth0, Keycloak, Azure AD, Okta, Google Workspace, or any OIDC-compliant provider.
 *
 * Flow: Authorization Code Flow with PKCE
 * - Browser redirects to IdP
 * - IdP returns authorization code
 * - Server exchanges code for tokens
 * - ID token validated against JWKS
 * - Userinfo endpoint called for profile
 */

import { createHash, createPublicKey, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';

export interface OIDCConfig {
  provider_name: string;
  client_id: string;
  client_secret?: string;
  issuer_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  redirect_uri: string;
  scopes: string[];
  response_type: 'code';
  pkce_enabled: boolean;
}

export interface OIDCUserInfo {
  sub: string;
  email: string;
  name?: string;
  groups?: string[];
  email_verified: boolean;
}

export interface OIDCTokenSet {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface OIDCAuthState {
  state: string;
  code_verifier?: string;
  code_challenge?: string;
  nonce: string;
  redirect_after: string;
  created_at: number;
}

export interface StepUpChallenge {
  challenge_id: string;
  user_id: string;
  action: string;
  status: 'pending' | 'verified' | 'expired';
  created_at: string;
  expires_at: string;
  verified_at?: string;
}

export class OIDCAbstraction {
  private pending_states: Map<string, OIDCAuthState> = new Map();
  private step_up_challenges: Map<string, StepUpChallenge> = new Map();

  constructor(private config: OIDCConfig) {}

  /**
   * Generate PKCE code verifier and challenge.
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  /**
   * Generate authorization URL for redirect to IdP.
   */
  generateAuthUrl(redirectAfter = '/'): { url: string; state: string } {
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');

    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;

    if (this.config.pkce_enabled) {
      const pkce = this.generatePKCE();
      codeVerifier = pkce.verifier;
      codeChallenge = pkce.challenge;
    }

    this.pending_states.set(state, {
      state,
      code_verifier: codeVerifier,
      code_challenge: codeChallenge,
      nonce,
      redirect_after: redirectAfter,
      created_at: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: this.config.client_id,
      response_type: this.config.response_type,
      scope: this.config.scopes.join(' '),
      redirect_uri: this.config.redirect_uri,
      state,
      nonce,
    });

    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    const url = `${this.config.authorization_endpoint}?${params.toString()}`;
    return { url, state };
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(code: string, state: string): Promise<OIDCTokenSet> {
    const authState = this.pending_states.get(state);
    if (!authState) {
      throw new OIDCError('INVALID_STATE', 'Authorization state not found or expired');
    }

    if (Date.now() - authState.created_at > 600_000) {
      this.pending_states.delete(state);
      throw new OIDCError('STATE_EXPIRED', 'Authorization state expired');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.client_id,
      code,
      redirect_uri: this.config.redirect_uri,
    });

    if (this.config.client_secret) {
      body.set('client_secret', this.config.client_secret);
    }

    if (authState.code_verifier) {
      body.set('code_verifier', authState.code_verifier);
    }

    this.pending_states.delete(state);

    const response = await fetch(this.config.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new OIDCError('TOKEN_EXCHANGE_FAILED', `Token exchange failed: ${response.status}`);
    }

    return response.json() as unknown as OIDCTokenSet;
  }

  /**
   * Fetch user info from the IdP userinfo endpoint.
   */
  async getUserInfo(accessToken: string): Promise<OIDCUserInfo> {
    const response = await fetch(this.config.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new OIDCError('USERINFO_FAILED', `Userinfo request failed: ${response.status}`);
    }

     return response.json() as unknown as OIDCUserInfo;
  }

  /** Validate an ID token signature and claims against the provider JWKS. */
  async validateIdToken(idToken: string): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
    const jwksResponse = await fetch(this.config.jwks_uri);
    if (!jwksResponse.ok) {
      throw new OIDCError('JWKS_FETCH_FAILED', 'Failed to fetch JWKS');
    }
    try {
      const jwks = await jwksResponse.json() as { keys?: Array<Record<string, unknown>> };
      const decoded = jwt.decode(idToken, { complete: true });
      if (!decoded || typeof decoded === 'string' || !decoded.header || typeof decoded.payload !== 'object' || decoded.payload === null) {
        return { valid: false };
      }
      const algorithms = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
      const { alg, kid } = decoded.header;
      if (typeof alg !== 'string' || !algorithms.includes(alg) || typeof kid !== 'string' || !Array.isArray(jwks.keys)) {
        return { valid: false };
      }
      const jwk = jwks.keys.find((candidate) => candidate.kid === kid && (candidate.use === undefined || candidate.use === 'sig') && (candidate.alg === undefined || candidate.alg === alg));
      if (!jwk) return { valid: false };
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      const payload = jwt.verify(idToken, publicKey, {
        algorithms: [alg as jwt.Algorithm],
        issuer: this.config.issuer_url,
        audience: this.config.client_id,
      });
      return typeof payload === 'string' ? { valid: false } : { valid: true, payload: payload as Record<string, unknown> };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Create a step-up authentication challenge.
   * User must re-authenticate before performing a critical action.
   */
  createStepUpChallenge(userId: string, action: string): StepUpChallenge {
    const challenge: StepUpChallenge = {
      challenge_id: `stepup-${randomBytes(16).toString('hex')}`,
      user_id: userId,
      action,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };

    this.step_up_challenges.set(challenge.challenge_id, challenge);
    return challenge;
  }

  /**
   * Verify a step-up challenge after re-authentication.
   */
  verifyStepUpChallenge(challengeId: string): boolean {
    const challenge = this.step_up_challenges.get(challengeId);
    if (!challenge) return false;

    if (new Date(challenge.expires_at) < new Date()) {
      challenge.status = 'expired';
      return false;
    }

    challenge.status = 'verified';
    challenge.verified_at = new Date().toISOString();
    return true;
  }

  /**
   * Check if a step-up challenge is verified for a given action.
   */
  isStepUpVerified(userId: string, action: string): boolean {
    for (const challenge of this.step_up_challenges.values()) {
      if (challenge.user_id === userId && challenge.action === action && challenge.status === 'verified') {
        if (new Date(challenge.expires_at) > new Date()) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Determine if an action requires step-up authentication.
   */
  static requiresStepUp(action: string): boolean {
    const stepUpActions = [
      'delete:task',
      'manage:config',
      'manage:users',
      'approve:task',
      'write:governance',
      'execute:task',
      'manage:policies',
      'manage:tokens',
    ];
    return stepUpActions.includes(action);
  }
}

export class OIDCError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OIDCError';
  }
}

/**
 * Create OIDC config from environment variables.
 * Supports: AUTH0, KEYCLOAK, AZURE_AD, OKTA, GOOGLE
 */
export function createOIDCConfigFromEnv(): OIDCConfig | null {
  const provider = process.env.OIDC_PROVIDER?.toLowerCase();
  if (!provider) return null;

  const clientId = process.env.OIDC_CLIENT_ID;
  if (!clientId) return null;

  const baseConfig = {
    client_id: clientId,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    redirect_uri: process.env.OIDC_REDIRECT_URI || 'http://localhost:3001/api/auth/callback',
    scopes: ['openid', 'profile', 'email'],
    response_type: 'code' as const,
    pkce_enabled: process.env.OIDC_DISABLE_PKCE !== 'true',
  };

  switch (provider) {
    case 'auth0':
      return {
        ...baseConfig,
        provider_name: 'Auth0',
        issuer_url: `https://${process.env.AUTH0_DOMAIN}/`,
        authorization_endpoint: `https://${process.env.AUTH0_DOMAIN}/authorize`,
        token_endpoint: `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
        userinfo_endpoint: `https://${process.env.AUTH0_DOMAIN}/userinfo`,
        jwks_uri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
      };

    case 'keycloak':
      return {
        ...baseConfig,
        provider_name: 'Keycloak',
        issuer_url: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}`,
        authorization_endpoint: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/auth`,
        token_endpoint: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
        userinfo_endpoint: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/userinfo`,
        jwks_uri: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/certs`,
      };

    case 'azure':
    case 'azure_ad':
      return {
        ...baseConfig,
        provider_name: 'Azure AD',
        issuer_url: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0`,
        authorization_endpoint: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
        userinfo_endpoint: `https://graph.microsoft.com/oidc/userinfo`,
        jwks_uri: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/discovery/v2.0/keys`,
      };

    default:
      return {
        ...baseConfig,
        provider_name: provider,
        issuer_url: process.env.OIDC_ISSUER_URL || '',
        authorization_endpoint: process.env.OIDC_AUTH_ENDPOINT || '',
        token_endpoint: process.env.OIDC_TOKEN_ENDPOINT || '',
        userinfo_endpoint: process.env.OIDC_USERINFO_ENDPOINT || '',
        jwks_uri: process.env.OIDC_JWKS_URI || '',
      };
  }
}
