# Common security checks (every project)

These run on any project regardless of platform: secrets, dependencies, repository hygiene, CI/CD, containers and infrastructure, and privacy. Platform files add their own checks on top.

How: **S** static, **D** dependencies, **G** git history, **A** agent review.

## 1. Secrets

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| COM-SEC-01 | Cloud / provider keys in code | AWS `AKIA…`, GCP service-account JSON, Azure connection strings, Stripe `sk_live_`, OpenAI/Anthropic keys, Slack/GitHub tokens, Twilio, SendGrid | S | Critical | CWE-798 |
| COM-SEC-02 | Private keys in repo | `-----BEGIN (RSA\|EC\|OPENSSH\|PRIVATE) KEY-----`, `.pem`, `.p8`, `.p12`, `.pfx`, `.jks`, `.keystore` | S | Critical | CWE-321 |
| COM-SEC-03 | Env files committed | `.env`, `.env.production`, `secrets.properties`, `local.properties` with secrets tracked by git | S | High | CWE-538 |
| COM-SEC-04 | High-entropy strings near secret-like names | `password=`, `secret=`, `token=`, `apiKey` with long literals | S | Medium | CWE-798 |
| COM-SEC-05 | Secrets in git history | secrets removed from HEAD but present in past commits | G | High | CWE-540 |
| COM-SEC-06 | `.gitignore` gaps | no ignore for `.env*`, `*.jks`, `*.pem`, `secrets.*` | S | Low | — |
| COM-SEC-07 | Test keys mislabeled as prod (or vice versa) | `pk_test_` in a `*_PROD` variable, live keys in test config | S | Info | — |
| COM-SEC-08 | Secrets in docs / samples | keys in README, docs, Postman collections, `.http` files, notebooks | S | High | CWE-798 |
| COM-SEC-09 | Shipped secret must be rotated | any secret that reached a released build or public repo | A | — | — |

## 2. Dependencies & supply chain

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| COM-DEP-01 | Known vulnerabilities | OSV / GitHub Advisory matches for npm, Maven/Gradle, PyPI, Go, Cargo, NuGet, Pub, CocoaPods, SwiftPM, Composer, RubyGems | D | by CVE | CWE-1104 |
| COM-DEP-02 | Unmaintained packages | no release in 2+ years, archived repos, deprecated packages | D | Low | CWE-1104 |
| COM-DEP-03 | No lockfile / lockfile drift | missing `package-lock.json`, `poetry.lock`, `gradle.lockfile`; lockfile out of sync | S | Low | CWE-829 |
| COM-DEP-04 | Unpinned / dynamic versions | `latest`, `*`, `+` (Gradle), `>=` ranges, git dependencies on branches | S | Medium | CWE-829 |
| COM-DEP-05 | Typosquat / suspicious names | names close to popular packages; new packages with install scripts | D | High | CWE-506 |
| COM-DEP-06 | Install scripts | `preinstall`/`postinstall` in dependencies | D | Low | CWE-506 |
| COM-DEP-07 | Untrusted registries / repos | `http://` Maven repos, `jitpack` for critical libs, extra npm registries, dependency confusion with private names | S | Medium | CWE-829 |
| COM-DEP-08 | License risk | GPL/AGPL/SSPL in closed-source or distributed apps | D | Info | — |
| COM-DEP-09 | Vendored copies of libraries | old copies of jQuery, OpenSSL, etc. checked into the repo | S | Medium | CWE-1104 |
| COM-DEP-10 | SBOM | generate CycloneDX/SPDX per release | D | Info | — |

## 3. CI/CD

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| COM-CI-01 | Untrusted code with secrets | GitHub `pull_request_target` checking out PR head; GitLab pipelines on unprotected/fork refs with unprotected variables | S | Critical | CWE-829 |
| COM-CI-02 | Script injection | `${{ github.event.issue.title }}` / PR body / branch name interpolated into `run:` | S | High | CWE-78 |
| COM-CI-03 | Actions not pinned to SHA | `uses: owner/action@v1` / `@main` for third-party actions | S | Medium | CWE-829 |
| COM-CI-04 | Token permissions too broad | no `permissions:` block (write-all default), `contents: write` everywhere | S | Medium | CWE-250 |
| COM-CI-05 | Secrets printed to logs | `echo $SECRET`, `set -x` with secrets, `env` dumps | S | High | CWE-532 |
| COM-CI-06 | Self-hosted runners on public repos | `runs-on: self-hosted` with fork PRs | S | High | CWE-250 |
| COM-CI-07 | Artifacts contain secrets | uploading build dirs with `.env`, keystores, `google-services.json` | S | Medium | CWE-538 |
| COM-CI-08 | Release signing in CI insecure | keystore/password as plain variables, available to all branches | S | High | CWE-522 |
| COM-CI-09 | No security gate | no dependency/secret scan in CI | S | Info | — |

## 4. Containers & infrastructure as code

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| COM-IAC-01 | Container runs as root | no `USER` in Dockerfile | S | Medium | CWE-250 |
| COM-IAC-02 | Unpinned base image | `FROM image:latest` or tag without digest | S | Low | CWE-829 |
| COM-IAC-03 | Secrets in image | `COPY .env`, `ARG`/`ENV` with secrets, keys in layers | S | High | CWE-538 |
| COM-IAC-04 | Over-exposed ports / services | docker-compose DB/Redis ports bound to `0.0.0.0`; default passwords | S | High | CWE-1188 |
| COM-IAC-05 | Privileged containers | `privileged: true`, `hostNetwork`, `hostPath` mounts, `docker.sock` mounted, `allowPrivilegeEscalation` | S | High | CWE-250 |
| COM-IAC-06 | Public storage | S3/GCS/Azure blobs public, `acl = "public-read"` | S | Critical | CWE-284 |
| COM-IAC-07 | Open security groups | `0.0.0.0/0` on SSH/RDP/DB ports | S | High | CWE-284 |
| COM-IAC-08 | Encryption off | unencrypted RDS/EBS/buckets, TLS off on load balancers | S | Medium | CWE-311 |
| COM-IAC-09 | IAM wildcards | `"Action": "*"`, `"Resource": "*"` | S | High | CWE-250 |
| COM-IAC-10 | K8s secrets in manifests | `Secret` objects with real values committed; secrets in ConfigMaps | S | High | CWE-538 |
| COM-IAC-11 | Missing resource limits / probes | pods without limits (DoS on neighbours) | S | Low | CWE-770 |

## 5. Privacy & compliance (any app handling personal data)

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| COM-PRV-01 | PII inventory | which features collect email, phone, location, contacts, health, payment data | A | Info | GDPR Art. 30 |
| COM-PRV-02 | PII sent to third parties | analytics/crash/ads SDKs and APIs receiving PII | S, A | Medium | MASVS-PRIVACY |
| COM-PRV-03 | Data retention / deletion | no account deletion path; data never purged | A | Medium | GDPR Art. 17 |
| COM-PRV-04 | Store disclosures mismatch | Play Data Safety / App Store privacy labels vs. actual collection | A | Low | — |
| COM-PRV-05 | Payment card data handled directly | card numbers touching your code/servers instead of the provider's SDK (PCI scope) | S, A | High | PCI DSS |

## 6. Repository & process hygiene

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| COM-REP-01 | No SECURITY.md / disclosure policy | missing security contact | S | Info | — |
| COM-REP-02 | Dependabot/Renovate absent | no automated dependency updates | S | Info | — |
| COM-REP-03 | Large binaries / dumps committed | DB dumps, logs, `.har` files with real data | S | High | CWE-538 |
| COM-REP-04 | Security-relevant TODOs | `TODO: auth`, `FIXME: validate`, `HACK` near auth/crypto code | S | Info | — |
