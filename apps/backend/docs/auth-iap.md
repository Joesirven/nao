# Google Identity-Aware Proxy (IAP) sign-in

When nao runs behind Google Cloud's Identity-Aware Proxy, users have already proved who they are to Google before any request reaches nao. With this feature on, the login page offers a single button such as **Continue as alice@example.com**, so users do not have to log in a second time.

The feature is off unless configured, and it is not available in cloud mode.

## How it works

1. IAP adds a signed JSON Web Token to every request in the `x-goog-iap-jwt-assertion` header.
2. The login page asks `GET /api/auth/iap/status` whether the current request carries a valid token. If it does, the page shows the button. If it does not, the page shows the normal login form.
3. Clicking the button calls `POST /api/auth/iap/sign-in`. The server verifies the header again and creates a normal nao session for that email. The button is only presentation: the browser never sends an identity of its own.

The token is verified as [Google documents it](https://docs.cloud.google.com/iap/docs/signed-headers-howto):

- the ES256 signature against Google's published keys (`https://www.gstatic.com/iap/verify/public_key-jwk`, cached and refreshed on key rotation);
- `iss` equal to `https://cloud.google.com/iap`;
- `aud` exactly equal to `NAO_IAP_AUDIENCE`;
- `exp` in the future and `iat` in the past, each with 30 seconds of clock skew, and a token no older than IAP ever issues;
- an email domain and a hosted domain (`hd` claim) that are both in `NAO_IAP_ALLOWED_DOMAINS`.

Requiring `hd` rejects personal Google accounts that happen to use a company address. The unsigned `x-goog-authenticated-user-email` header is never trusted. Any failure means no session, and the user sees the normal login page.

## Environment variables

| Variable                      | Required | Default  | Description                                                                                                                                                    |
| ----------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NAO_IAP_AUDIENCE`            | Yes      | —        | Expected `aud` claim. See [Finding the audience](#finding-the-audience).                                                                                       |
| `NAO_IAP_ALLOWED_DOMAINS`     | Yes      | —        | Comma-separated email domains, for example `example.com`. The feature stays off if this is empty.                                                              |
| `NAO_IAP_ADMIN_EMAILS`        | No       | —        | Comma-separated emails that become organization and default project administrators when they sign in through IAP.                                              |
| `NAO_IAP_DEFAULT_ROLE`        | No       | `viewer` | Role given to users created through IAP: `viewer`, `user` or `admin`. Viewers cannot send chat messages, so most deployments that want chat should use `user`. |
| `NAO_IAP_BUTTON_LABEL`        | No       | —        | Replaces `Continue as <email>`, for example `Sign in with your company Google account`. The verified email is still shown under the button.                    |
| `NAO_IAP_HIDE_PASSWORD_LOGIN` | No       | `true`   | Hides the email and password fields while a verified identity is present. Set to `false` to keep them reachable.                                               |

`BETTER_AUTH_URL` must be the URL users reach through IAP, because the sign-in request is checked against it as a trusted origin.

Hiding the password fields is presentation only. To turn password login off on the server as well, set `ENABLE_USER_LOGIN=false`; read [Recovery](#recovery) first.

## Finding the audience

The audience depends on what IAP protects:

| Resource                                          | Audience format                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| Cloud Run service with IAP enabled on the service | `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME` |
| Load balancer backend service                     | `/projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID`      |
| App Engine                                        | `/projects/PROJECT_NUMBER/apps/PROJECT_ID`                        |

`PROJECT_NUMBER` is the numeric project number, not the project ID. For example: `/projects/123456789/locations/us-central1/services/nao`. The Google Cloud console shows the exact value under **Signed Header JWT Audience** on the IAP page. Source: [Securing your app with signed headers](https://docs.cloud.google.com/iap/docs/signed-headers-howto).

## Users and roles

- **New users** are created with the email from the token, a verified email, and `NAO_IAP_DEFAULT_ROLE` in the default organization and the default project. Who may get an account is decided by IAP's own access policy and `NAO_IAP_ALLOWED_DOMAINS`, not by `ENABLE_USER_SIGNUP`, which only governs password sign-up.
- **Existing users** with the same email land in their existing account. They keep the same user ID, roles, user groups and chat history. Signing in through IAP adds no membership to their account.
- **Unverified existing accounts.** nao does not verify emails at password sign-up. When an account whose email was never verified links through IAP, nao first deletes that account's password and sessions, then marks the email as verified. Otherwise anyone who registered a colleague's address in advance would keep password access to the colleague's account. Those users then sign in through IAP only. To give one a password again, see [Recovery](#recovery).
- **Administrators.** Emails in `NAO_IAP_ADMIN_EMAILS` are made administrator of the organization and the default project at every IAP sign-in. Removing an email from the list does not demote that user; change the role in the settings instead. Emails not in the list are never promoted.
- **First administrator.** On a fresh install with no organization, only an email in `NAO_IAP_ADMIN_EMAILS` can create the first account through IAP; anyone else is refused until that administrator has signed in. The first person through the proxy never becomes administrator just by arriving first. (Password sign-up keeps its existing behaviour: when sign-up is enabled, the first password user of an empty install still becomes administrator.)

## Sign-out

Signing out of nao ends the nao session and returns the user to the login page. The page shows the IAP button again but never signs in by itself, so there is no sign-out loop. To also end the IAP session, for example on a shared computer, open `https://YOUR_APP_URL/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`. This clears IAP's cookies. Google may sign the user back in silently if only one Google account is in use ([IAP special URLs](https://docs.cloud.google.com/iap/docs/special-urls-howto)). Google documents this URL for IAP in general; the page does not say whether it applies to IAP enabled directly on a Cloud Run service, so confirm it on your deployment.

If a different person later passes IAP in the same browser while the earlier nao session is still active, that nao session stays active until it expires or the earlier user signs out.

## Recovery

- **IAP misconfigured** (wrong audience or domains): no token verifies, so the login page shows the normal form. Fix the variables and restart.
- **Bring the password fields back** while IAP works: set `NAO_IAP_HIDE_PASSWORD_LOGIN=false` and restart. Password login also needs `ENABLE_USER_LOGIN=true`.
- **A user without a password** (created through IAP, or whose unverified password was revoked when linking): on the server, run `nao reset-password <email>`, or `nao-chat-server reset-password --email <email>` in the container. The command creates a temporary password when the account has none, and the user must choose a new one at the next login.

## Checking a deployment

IAP can replace the header with a deliberately broken token ([IAP special URLs](https://docs.cloud.google.com/iap/docs/special-urls-howto)). Google documents these test modes for IAP in general but not specifically for IAP enabled directly on a Cloud Run service. First confirm that IAP honours them on your deployment: with a test type set, the response should differ from the plain request. A status of `"email": null` only proves something when IAP really sent a broken token. While signed in through IAP, open the status endpoint with each test type. A correct deployment returns `"email": null` for every broken token, and your email without the test parameters:

```
https://YOUR_APP_URL/api/auth/iap/status
https://YOUR_APP_URL/api/auth/iap/status?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=AUDIENCE
https://YOUR_APP_URL/api/auth/iap/status?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=SIGNATURE
https://YOUR_APP_URL/api/auth/iap/status?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=ISSUER
https://YOUR_APP_URL/api/auth/iap/status?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=PAST_EXPIRATION
https://YOUR_APP_URL/api/auth/iap/status?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=FUTURE_ISSUE
https://YOUR_APP_URL/api/auth/iap/status?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=NOT_SET
```

Rejected tokens are logged with the reason only (for example `ERR_JWT_EXPIRED`), never the token itself.
