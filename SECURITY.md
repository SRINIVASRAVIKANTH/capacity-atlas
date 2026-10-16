# Security

## Reporting a problem

Please report security issues privately through GitHub: the repository's **Security** tab,
then **Report a vulnerability**. Please do not open a public issue for a security problem.

## How the project is protected

| Area | Protection |
|---|---|
| API key for the assistant | Stored only as an encrypted Cloudflare secret. Never in the repository, the website or the browser. |
| Assistant endpoint (`/api/ask`) | Same-site requests only, 300-character questions, 2 KB body limit, 6 questions a minute and 60 a day per visitor, 15-second limit on each call to the Claude API, prepaid credit with auto reload off. |
| AI output | Claude can only fill one fixed tool. The function keeps known fields and values and drops everything else, and the page shows every text as plain text, never as HTML. |
| Website | Content Security Policy in `web/_headers`: scripts only from the site itself, data only from the listed services, no framing by other sites. |
| Map data on Cloudflare R2 | The bucket's CORS policy allows only `https://capacity-atlas.pages.dev`, so other websites cannot load the data from it. |
| Data from utilities | Treated as untrusted: every value is escaped before it is shown. |
| Test-only URL options | `?data=` and `?basemap=` work only on a local copy, so nobody can link to the live site showing other data. |
| Weekly automation | Secrets are passed only to the step that needs them. The tests workflow has read-only access. Dependabot proposes dependency updates monthly. |
