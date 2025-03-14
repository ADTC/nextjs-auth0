import nock from 'nock';
import { CookieJar } from 'tough-cookie';
import * as jose from 'jose';
import { signing } from '../../../src/auth0-session/utils/hkdf';
import { encodeState } from '../../../src/auth0-session/utils/encoding';
import { SessionResponse, setup, teardown } from '../fixtures/server';
import { makeIdToken } from '../fixtures/cert';
import { toSignedCookieJar, get, post, defaultConfig, decodeJWT } from '../fixtures/helpers';
import { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as qs from 'querystring';

const privateKey = readFileSync(join(__dirname, '..', 'fixtures', 'private-key.pem'), 'utf-8');

const expectedDefaultState = encodeState({ returnTo: 'https://example.org' });

const authVerificationCookie = (cookies: Record<string, string>) => ({ auth_verification: JSON.stringify(cookies) });

describe('callback', () => {
  afterEach(teardown);

  it('should error when the body is empty', async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        nonce: '__test_nonce__',
        state: '__test_state__'
      }),
      baseURL
    );

    await expect(post(baseURL, '/callback', { body: {}, cookieJar })).rejects.toThrow(
      'Missing state parameter in Authorization Response.'
    );
  });

  it('should error when the state cookie is missing', async () => {
    const baseURL = await setup(defaultConfig);

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__test_state__',
          id_token: '__invalid_token__'
        },
        cookieJar: new CookieJar()
      })
    ).rejects.toThrowError(
      'Missing state cookie from login request (check login URL, callback URL and cookie config).'
    );
  });

  it('should error when auth_verification cookie is malformed', async () => {
    const baseURL = await setup(defaultConfig);

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__test_state__',
          id_token: '__invalid_token__'
        },
        cookieJar: await toSignedCookieJar({ auth_verification: 'not json' }, baseURL)
      })
    ).rejects.toThrowError('Your state cookie is not valid JSON.');
  });

  it("should error when state doesn't match", async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        nonce: '__valid_nonce__',
        state: '__valid_state__'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__invalid_state__',
          id_token: '__invalid_token__'
        },
        cookieJar
      })
    ).rejects.toThrowError('state mismatch, expected __valid_state__, got: __invalid_state__');
  });

  it("should error when id_token can't be parsed", async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        nonce: '__valid_nonce__',
        state: '__valid_state__'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__valid_state__',
          id_token: '__invalid_token__'
        },
        cookieJar
      })
    ).rejects.toThrowError('failed to decode JWT (Error: JWTs must have three components)');
  });

  it('should error when id_token has invalid alg', async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        nonce: '__valid_nonce__',
        state: '__valid_state__'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__valid_state__',
          id_token: await new jose.SignJWT({ sub: '__test_sub__' })
            .setProtectedHeader({ alg: 'HS256' })
            .sign(await signing('secret'))
        },
        cookieJar
      })
    ).rejects.toThrowError('unexpected JWT alg received, expected RS256, got: HS256');
  });

  it('should error when id_token is missing issuer', async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        nonce: '__valid_nonce__',
        state: '__valid_state__'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__valid_state__',
          id_token: await makeIdToken({ iss: undefined })
        },
        cookieJar
      })
    ).rejects.toThrowError('missing required JWT property iss');
  });

  it('should error when nonce is missing from cookies', async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: '__valid_state__'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__valid_state__',
          id_token: await makeIdToken({ nonce: '__test_nonce__' })
        },
        cookieJar
      })
    ).rejects.toThrowError('nonce mismatch, expected undefined, got: __test_nonce__');
  });

  it('should error when legacy samesite fallback is off', async () => {
    const baseURL = await setup({ ...defaultConfig, legacySameSiteCookie: false });

    const cookieJar = await toSignedCookieJar(
      {
        _auth_verification: JSON.stringify({ state: '__valid_state__' })
      },
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '__valid_state__',
          id_token: await makeIdToken()
        },
        cookieJar
      })
    ).rejects.toThrowError(
      'Missing state cookie from login request (check login URL, callback URL and cookie config).'
    );
  });

  it('should error for expired ID token', async () => {
    const baseURL = await setup({ ...defaultConfig, legacySameSiteCookie: false });

    const expected = {
      nickname: '__test_nickname__',
      sub: '__test_sub__',
      iss: 'https://op.example.com/',
      aud: '__test_client_id__',
      nonce: '__test_nonce__',
      auth_time: 10
    };

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__',
        max_age: '100'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: expectedDefaultState,
          id_token: await makeIdToken(expected)
        },
        cookieJar
      })
    ).rejects.toThrowError('too much time has elapsed since the last End-User authentication');
  });

  it('should expose the id token claims when id_token is valid', async () => {
    const baseURL = await setup({ ...defaultConfig, legacySameSiteCookie: false });

    const expected = {
      nickname: '__test_nickname__',
      sub: '__test_sub__',
      iss: 'https://op.example.com/',
      aud: '__test_client_id__',
      nonce: '__test_nonce__'
    };

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    const { res } = await post(baseURL, '/callback', {
      body: {
        state: expectedDefaultState,
        id_token: await makeIdToken(expected)
      },
      cookieJar,
      fullResponse: true
    });

    const session: SessionResponse = await get(baseURL, '/session', { cookieJar });

    expect(res.headers.location).toEqual('https://example.org');
    expect(session.claims).toEqual(expect.objectContaining(expected));
  });

  it("should fail when the Authorization Response params don't match the response_type", async () => {
    const baseURL = await setup({ ...defaultConfig, authorizationParams: { response_type: 'id_token' } });

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__',
        response_type: 'code id_token'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: expectedDefaultState,
          id_token: await makeIdToken()
        },
        cookieJar,
        fullResponse: true
      })
    ).rejects.toThrowError('code missing from response');
  });

  it("should expose all tokens when id_token is valid and response_type is 'code id_token'", async () => {
    const baseURL = await setup({
      ...defaultConfig,
      clientSecret: '__test_client_secret__',
      authorizationParams: {
        response_type: 'code id_token',
        audience: 'https://api.example.com/',
        scope: 'openid profile email read:reports offline_access'
      }
    });

    const idToken = await makeIdToken({
      c_hash: '77QmUPtjPfzWtF2AnpK9RQ'
    });

    nock('https://op.example.com')
      .post('/oauth/token')
      .reply(200, () => ({
        access_token: '__test_access_token__',
        refresh_token: '__test_refresh_token__',
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 86400
      }));

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    await post(baseURL, '/callback', {
      body: {
        state: expectedDefaultState,
        id_token: idToken,
        code: 'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y'
      },
      cookieJar
    });

    const session: SessionResponse = await get(baseURL, '/session', { cookieJar });
    expect(session).toEqual(
      expect.objectContaining({
        token_type: 'Bearer',
        access_token: '__test_access_token__',
        id_token: idToken,
        refresh_token: '__test_refresh_token__',
        expires_at: expect.any(Number)
      })
    );
  });

  it('should use basic auth on token endpoint when using code flow', async () => {
    const idToken = await makeIdToken({
      c_hash: '77QmUPtjPfzWtF2AnpK9RQ'
    });

    const baseURL = await setup({
      ...defaultConfig,
      clientSecret: '__test_client_secret__',
      authorizationParams: {
        response_type: 'code id_token',
        audience: 'https://api.example.com/',
        scope: 'openid profile email read:reports offline_access'
      }
    });

    let credentials = '';
    let body = '';
    nock('https://op.example.com')
      .post('/oauth/token')
      .reply(200, function (_uri, requestBody) {
        credentials = this.req.headers.authorization.replace('Basic ', '');
        body = requestBody as string;
        return {
          access_token: '__test_access_token__',
          refresh_token: '__test_refresh_token__',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 86400
        };
      });

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    const code = 'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y';
    await post(baseURL, '/callback', {
      body: {
        state: expectedDefaultState,
        id_token: idToken,
        code
      },
      cookieJar
    });

    expect(Buffer.from(credentials, 'base64').toString()).toEqual('__test_client_id__:__test_client_secret__');
    expect(body).toEqual(
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(baseURL)}%2Fcallback`
    );
  });

  it('should use private key jwt on token endpoint', async () => {
    const idToken = await makeIdToken({
      c_hash: '77QmUPtjPfzWtF2AnpK9RQ'
    });

    const baseURL = await setup({
      ...defaultConfig,
      authorizationParams: {
        response_type: 'code'
      },
      clientAssertionSigningKey: privateKey
    });

    let body: qs.ParsedUrlQuery = {};
    nock('https://op.example.com')
      .post('/oauth/token')
      .reply(200, function (_uri, requestBody) {
        body = qs.parse(requestBody as string);
        return {
          access_token: '__test_access_token__',
          refresh_token: '__test_refresh_token__',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 86400
        };
      });

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    await post(baseURL, '/callback', {
      body: {
        state: expectedDefaultState,
        id_token: idToken,
        code: 'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y'
      },
      cookieJar,
      fullResponse: true
    });

    expect(body.client_assertion).not.toBeUndefined();
    expect(body.client_assertion_type).toEqual('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

    const { header } = decodeJWT(body.client_assertion as string);

    expect(header.alg).toEqual('RS256');
  });

  it('should redirect to default base url', async () => {
    const baseURL = await setup(defaultConfig);

    const state = encodeState({ foo: 'bar' });
    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: state,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    const { res } = await post(baseURL, '/callback', {
      body: {
        state: state,
        id_token: await makeIdToken()
      },
      cookieJar,
      fullResponse: true
    });

    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual(baseURL);
  });

  it('should accept custom runtime redirect over base url', async () => {
    const redirectUri = 'http://messi:3000/api/auth/callback/runtime';
    const baseURL = await setup(defaultConfig, { callbackOptions: { redirectUri } });
    const state = encodeState({ foo: 'bar' });
    const cookieJar = await toSignedCookieJar(authVerificationCookie({ state, nonce: '__test_nonce__' }), baseURL);
    const { res } = await post(baseURL, '/callback', {
      body: {
        state: state,
        id_token: await makeIdToken()
      },
      cookieJar,
      fullResponse: true
    });

    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual(baseURL);
  });

  it('should not overwrite location header if set in after callback', async () => {
    const baseURL = await setup(defaultConfig, {
      callbackOptions: {
        afterCallback(_req: IncomingMessage, res: ServerResponse, session: any) {
          res.setHeader('Location', '/foo');
          return session;
        }
      }
    });

    const state = encodeState({ foo: 'bar' });
    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: state,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    const { res } = await post(baseURL, '/callback', {
      body: {
        state: state,
        id_token: await makeIdToken()
      },
      cookieJar,
      fullResponse: true
    });

    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/foo');
    expect(cookieJar.getCookieStringSync(baseURL)).toMatch(/^appSession=.*/);
  });

  it('should terminate the request in after callback and not set session if none returned', async () => {
    const baseURL = await setup(defaultConfig, {
      callbackOptions: {
        afterCallback(_req, res: ServerResponse) {
          res.writeHead(401).end();
        }
      }
    });

    const state = encodeState({ foo: 'bar' });
    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: state,
        nonce: '__test_nonce__'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: state,
          id_token: await makeIdToken()
        },
        cookieJar,
        fullResponse: true
      })
    ).rejects.toThrow('Unauthorized');
    expect(cookieJar.getCookieStringSync(baseURL)).toBeFalsy();
  });

  it('should escape Identity Provider error', async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__',
        response_type: 'code id_token'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: expectedDefaultState,
          error: '<script>alert(1)</script>',
          error_description: '<script>alert(2)</script>'
        },
        cookieJar,
        fullResponse: true
      })
    ).rejects.toThrowError('&lt;script&gt;alert(1)&lt;/script&gt; (&lt;script&gt;alert(2)&lt;/script&gt;)');
  });

  it('should escape application error', async () => {
    const baseURL = await setup(defaultConfig);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__',
        response_type: 'code id_token'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: '<script>alert(1)</script>',
          id_token: await makeIdToken()
        },
        cookieJar,
        fullResponse: true
      })
    ).rejects.toThrowError(
      `state mismatch, expected ${expectedDefaultState}, got: &lt;script&gt;alert(1)&lt;/script&gt;`
    );
  });

  it('should handle discovery error', async () => {
    const baseURL = await setup({ ...defaultConfig, issuerBaseURL: 'https://op2.example.com' });
    nock('https://op2.example.com').get('/.well-known/openid-configuration').reply(500);

    const cookieJar = await toSignedCookieJar(
      authVerificationCookie({
        state: expectedDefaultState,
        nonce: '__test_nonce__',
        response_type: 'code id_token'
      }),
      baseURL
    );

    await expect(
      post(baseURL, '/callback', {
        body: {
          state: expectedDefaultState,
          id_token: await makeIdToken()
        },
        cookieJar,
        fullResponse: true
      })
    ).rejects.toThrowError(
      'Discovery requests failing for https://op2.example.com, expected 200 OK, got: 500 Internal Server Error'
    );
  });

  it('should use custom transaction cookie name', async () => {
    const idToken = await makeIdToken({
      c_hash: '77QmUPtjPfzWtF2AnpK9RQ'
    });

    const baseURL = await setup({
      ...defaultConfig,
      clientSecret: '__test_client_secret__',
      authorizationParams: {
        response_type: 'code id_token',
        audience: 'https://api.example.com/',
        scope: 'openid profile email read:reports offline_access'
      },
      transactionCookie: { name: 'foo_bar' }
    });

    let credentials = '';
    let body = '';
    nock('https://op.example.com')
      .post('/oauth/token')
      .reply(200, function (_uri, requestBody) {
        credentials = this.req.headers.authorization.replace('Basic ', '');
        body = requestBody as string;
        return {
          access_token: '__test_access_token__',
          refresh_token: '__test_refresh_token__',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 86400
        };
      });

    const cookieJar = await toSignedCookieJar(
      {
        foo_bar: JSON.stringify({
          state: expectedDefaultState,
          nonce: '__test_nonce__'
        })
      },
      baseURL
    );

    const code = 'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y';
    await post(baseURL, '/callback', {
      body: {
        state: expectedDefaultState,
        id_token: idToken,
        code
      },
      cookieJar
    });

    expect(Buffer.from(credentials, 'base64').toString()).toEqual('__test_client_id__:__test_client_secret__');
    expect(body).toEqual(
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(baseURL)}%2Fcallback`
    );
  });
});
