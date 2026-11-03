# Backend & API security checks

Applies to: HTTP/GraphQL/gRPC servers, workers and serverless functions — Node (Express, Nest, Fastify, Next.js API/server actions), Python (Django, Flask, FastAPI), JVM (Spring, Ktor), Go, .NET, PHP (Laravel, Symfony), Ruby (Rails).
Standards: OWASP Top 10 2021, OWASP API Security Top 10 2023, OWASP ASVS 4, CWE. Shared checks in [common.md](common.md).

How: **S** static, **D** dependencies, **R** runtime against the local server (localhost only), **A** agent review.

Sections 1–10 apply to every backend. Section 11 lists the patterns each language/framework needs for the static rules.

## 1. Authentication

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-AUN-01 | Route without auth | handlers missing auth middleware/decorator/attribute that touch user data | S, A, R | Critical | API2, CWE-306 |
| API-AUN-02 | Weak password hashing | MD5/SHA-1/SHA-256 for passwords, no salt, bcrypt cost < 10 | S | High | CWE-916 |
| API-AUN-03 | JWT verification flaws | `alg: none` accepted, `decode` instead of `verify`, HS/RS confusion, no `exp`/`aud`/`iss` check | S | Critical | CWE-347 |
| API-AUN-04 | Hard-coded / weak JWT or session secret | `secret`, `changeme`, secret in source | S | Critical | CWE-798 |
| API-AUN-05 | No brute-force protection | login, OTP, password reset, 2FA without rate limit / lockout | S, R | High | API4, CWE-307 |
| API-AUN-06 | Password reset flaws | guessable or long-lived tokens, token not single-use, host-header-based reset links, user enumeration | S, A, R | High | CWE-640 |
| API-AUN-07 | User enumeration | different responses/timing for unknown vs. known accounts | R | Low | CWE-204 |
| API-AUN-08 | Session not rotated / revoked | no session id rotation on login; logout doesn't invalidate; refresh tokens not rotated | S, R | Medium | CWE-384, CWE-613 |
| API-AUN-09 | OAuth / OIDC server-side flaws | redirect_uri not exact-matched, state not checked, ID token not validated | S, A | High | CWE-601 |
| API-AUN-10 | MFA bypass | MFA step skippable by calling the next endpoint directly | R, A | High | CWE-287 |
| API-AUN-11 | Timing-unsafe comparison | `==` on tokens/HMACs instead of constant-time compare | S | Low | CWE-208 |

## 2. Authorization

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-AUZ-01 | IDOR / BOLA | objects fetched by id from the request without owner/tenant check | S, A, R | Critical | API1, CWE-639 |
| API-AUZ-02 | Function-level authz missing | admin/staff endpoints callable by normal users | S, R | Critical | API5, CWE-285 |
| API-AUZ-03 | Mass assignment | request body bound straight to models (`role`, `isAdmin`, `ownerId`, `price`) | S, R | High | API3, CWE-915 |
| API-AUZ-04 | Excessive data exposure | whole model serialised (password hash, tokens, internal fields) | S, R | High | API3, CWE-213 |
| API-AUZ-05 | Multi-tenant isolation | queries missing `tenant_id` scope; RLS disabled | S, A | Critical | CWE-284 |
| API-AUZ-06 | Authorization matrix test | each endpoint × each role (anon, user A, user B, admin) behaves as intended | R | — | WSTG-ATHZ |
| API-AUZ-07 | GraphQL field/resolver authz | auth only at the query root, nested resolvers unchecked | S, A | High | API1 |

## 3. Injection

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-INJ-01 | SQL injection | string-built SQL, raw queries with interpolation, ORM `raw`/`extra`/`whereRaw` with input | S, R | Critical | CWE-89 |
| API-INJ-02 | NoSQL injection | Mongo queries from raw request objects (`{$ne: null}`), `$where` | S, R | High | CWE-943 |
| API-INJ-03 | Command injection | `exec`, `system`, `subprocess(shell=True)`, `Runtime.exec` with input | S | Critical | CWE-78 |
| API-INJ-04 | Server-side template injection | rendering templates built from user strings (Jinja `from_string`, Thymeleaf expressions, EJS/Handlebars compile) | S | Critical | CWE-1336 |
| API-INJ-05 | LDAP / XPath injection | filters built from input | S | High | CWE-90, CWE-643 |
| API-INJ-06 | Header / log injection | CRLF in headers, unescaped input in logs | S | Low | CWE-113, CWE-117 |
| API-INJ-07 | Code eval | `eval`, `vm.runInContext`, `exec()` (Python), `ScriptEngine` on input | S | Critical | CWE-95 |
| API-INJ-08 | Prompt injection in LLM features | user/retrieved content mixed into tool-using prompts; model output executed or trusted for authz | A | High | OWASP LLM01 |

## 4. Server-side requests, files & parsing

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-SRV-01 | SSRF | server fetching user-supplied URLs (webhooks, previews, imports) without allowlist / metadata-IP block | S, R | High | API7, CWE-918 |
| API-SRV-02 | Path traversal | file paths joined from input without canonical check | S, R | High | CWE-22 |
| API-SRV-03 | Unrestricted upload | no type/size checks; uploads stored in web root; executable extensions | S, R | High | CWE-434 |
| API-SRV-04 | Insecure deserialization | `pickle`, `yaml.load`, Java `ObjectInputStream`, .NET `BinaryFormatter`, PHP `unserialize` on input | S | Critical | CWE-502 |
| API-SRV-05 | XXE | XML parsers with external entities enabled | S | High | CWE-611 |
| API-SRV-06 | Zip slip / archive bombs | extracting archives without path and size limits | S | High | CWE-22, CWE-409 |
| API-SRV-07 | Open redirect | `redirect(req.query.next)` | S, R | Medium | CWE-601 |
| API-SRV-08 | ReDoS | catastrophic regexes on request input | S | Medium | CWE-1333 |

## 5. Transport, CORS & headers

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-HTTP-01 | CORS too open | `Access-Control-Allow-Origin: *` with credentials; origin reflected; regex allowing `evil-example.com` | S, R | High | CWE-942 |
| API-HTTP-02 | CSRF on cookie-auth endpoints | no CSRF middleware / SameSite on state-changing routes | S, R | High | CWE-352 |
| API-HTTP-03 | TLS verification off for outbound calls | `verify=False`, `rejectUnauthorized: false`, `InsecureSkipVerify: true` | S | High | CWE-295 |
| API-HTTP-04 | Security headers missing | for HTML responses: CSP, HSTS, X-Content-Type-Options, frame-ancestors | R | Low | — |
| API-HTTP-05 | Cookie flags | session cookies without `Secure`/`HttpOnly`/`SameSite` | S, R | Medium | CWE-614 |
| API-HTTP-06 | HTTP method confusion | GET handlers that change state; method override headers honoured | S | Medium | CWE-650 |

## 6. Rate limits & resource use

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-RES-01 | No rate limiting | public and auth endpoints without limits | S, R | Medium | API4 |
| API-RES-02 | Unbounded queries | no pagination max, `limit` from input unbounded | S, R | Medium | API4, CWE-770 |
| API-RES-03 | Body / upload size unbounded | no body size limit, multipart limits | S | Medium | CWE-400 |
| API-RES-04 | GraphQL depth / complexity | no depth limit, introspection on in production, batching abuse | S, R | Medium | API4 |
| API-RES-05 | Expensive ops for anonymous users | email/SMS sending, PDF generation, LLM calls without auth or quota | A | Medium | API6 |

## 7. Business logic

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-BIZ-01 | Price / quantity tampering | prices, discounts, totals taken from the client | A, R | High | API6, CWE-840 |
| API-BIZ-02 | Negative / overflow values | negative quantities, transfers, refunds | A, R | High | CWE-191 |
| API-BIZ-03 | Race conditions | double-spend, coupon reuse, balance checks without locking/transactions | A, R | High | CWE-362 |
| API-BIZ-04 | Workflow step skipping | finishing checkout/onboarding/verification by calling the last step | R, A | High | CWE-841 |
| API-BIZ-05 | Webhook authenticity | incoming webhooks (Stripe, GitHub…) without signature verification | S | High | CWE-345 |
| API-BIZ-06 | Idempotency | payment/create endpoints without idempotency keys | A | Low | — |

## 8. Errors, logging & monitoring

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-LOG-01 | Stack traces / debug pages exposed | `DEBUG=True`, `app.debug`, Spring whitelabel with traces, Express default error handler in prod | S, R | Medium | CWE-209 |
| API-LOG-02 | Secrets / PII in logs | logging request bodies, headers (`Authorization`), passwords | S | Medium | CWE-532 |
| API-LOG-03 | No audit log for security events | logins, permission changes, admin actions not logged | A | Low | CWE-778 |
| API-LOG-04 | Debug / admin endpoints exposed | Spring Actuator `/env`, `/heapdump`; Django admin on default path; `/debug/pprof`; phpinfo | S, R | High | CWE-489 |

## 9. Data protection

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-DAT-01 | Sensitive fields unencrypted at rest | tokens, national ids, API keys of customers stored in plaintext columns | S, A | Medium | CWE-312 |
| API-DAT-02 | Weak crypto | ECB, static IV, MD5/SHA-1 signatures, `Math.random`/`random` for tokens | S | High | CWE-327, CWE-338 |
| API-DAT-03 | Secrets from env with insecure defaults | `process.env.SECRET \|\| 'dev'` | S | High | CWE-1188 |
| API-DAT-04 | Backups / exports unprotected | DB dumps in public buckets or web root | S, A | High | CWE-530 |

## 10. Inventory

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| API-INV-01 | Shadow / old API versions | `/v1` still live without the fixes of `/v2`; test routes in production | S, A | Medium | API9 |
| API-INV-02 | Unsafe consumption of third-party APIs | trusting responses from partners without validation; following their redirects | A | Medium | API10 |
| API-INV-03 | OpenAPI spec vs. code drift | endpoints in code missing from spec (unreviewed surface) | S | Info | API9 |

## 11. Language / framework patterns

What the static rules match for each stack. Each row points back to a check above.

### Node.js / TypeScript (Express, Nest, Fastify, Next.js)
| Pattern | Check |
|---|---|
| `` db.query(`… ${x}`) ``, `sequelize.query` with interpolation, Prisma `$queryRawUnsafe`, Knex `whereRaw(x)` | API-INJ-01 |
| `Model.find(req.body)`, `findOne({ email: req.body.email })` without type check | API-INJ-02 |
| `child_process.exec(` with input, `shell: true` | API-INJ-03 |
| `jwt.decode(` used for auth, `algorithms` not set in `jwt.verify` | API-AUN-03 |
| `cors({ origin: true, credentials: true })`, `origin: '*'` + credentials | API-HTTP-01 |
| `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` | API-HTTP-03 |
| `res.redirect(req.query.*)` | API-SRV-07 |
| Next.js server actions / route handlers without session check; `"use server"` functions trusting args | API-AUN-01, API-AUZ-01 |
| Nest controllers without `@UseGuards` where siblings have it | API-AUN-01 |
| `express.json()` without `limit`, no `helmet` | API-RES-03, API-HTTP-04 |
| `vm.runInNewContext`, `eval`, `new Function` on input | API-INJ-07 |
| `Object.assign(user, req.body)`, `prisma.user.update({ data: req.body })` | API-AUZ-03 |

### Python (Django, Flask, FastAPI)
| Pattern | Check |
|---|---|
| `cursor.execute(f"…")`, `.raw(`, `.extra(`, SQLAlchemy `text(f"…")` | API-INJ-01 |
| `subprocess.*(shell=True)`, `os.system`, `os.popen` | API-INJ-03 |
| `pickle.loads`, `yaml.load` without `SafeLoader`, `marshal`, `shelve` | API-SRV-04 |
| `DEBUG = True`, `ALLOWED_HOSTS = ['*']`, `SECRET_KEY` literal | API-LOG-01, API-AUN-04 |
| `@csrf_exempt`, `CSRF_COOKIE_SECURE = False`, `SESSION_COOKIE_SECURE = False` | API-HTTP-02, API-HTTP-05 |
| `render_template_string(`, `Template(user)` | API-INJ-04 |
| `requests.*(verify=False)` | API-HTTP-03 |
| FastAPI routes without `Depends(auth)` where siblings have it | API-AUN-01 |
| `ModelSerializer` with `fields = '__all__'` | API-AUZ-03, API-AUZ-04 |
| `lxml` / `xml.etree` on untrusted input (use defusedxml) | API-SRV-05 |

### JVM (Spring Boot, Ktor, Micronaut)
| Pattern | Check |
|---|---|
| `"SELECT … " + x` in `JdbcTemplate`, `createQuery`/`createNativeQuery` concatenation | API-INJ-01 |
| `permitAll()` on sensitive matchers, `csrf().disable()` with cookie sessions | API-AUZ-02, API-HTTP-02 |
| `management.endpoints.web.exposure.include=*` | API-LOG-04 |
| `ObjectInputStream`, Jackson `enableDefaultTyping` / `@JsonTypeInfo(use = CLASS)`, XStream | API-SRV-04 |
| `DocumentBuilderFactory` without `disallow-doctype-decl` | API-SRV-05 |
| `@CrossOrigin("*")` with credentials | API-HTTP-01 |
| `@RequestBody Entity` bound directly to JPA entities | API-AUZ-03 |
| SpEL `parseExpression(input)`, Thymeleaf `__${…}__` | API-INJ-04 |
| Ktor routes outside `authenticate { }` | API-AUN-01 |

### Go
| Pattern | Check |
|---|---|
| `db.Query(fmt.Sprintf(…))`, `db.Exec("…" + x)` | API-INJ-01 |
| `exec.Command("sh", "-c", x)` | API-INJ-03 |
| `InsecureSkipVerify: true` | API-HTTP-03 |
| `text/template` for HTML, `template.HTML(input)` | WEB-XSS / API-INJ-04 |
| `filepath.Join(base, userPath)` without `filepath.Rel`/prefix check | API-SRV-02 |
| `net/http/pprof` imported in prod build | API-LOG-04 |
| `http.ListenAndServe` without timeouts (slowloris) | API-RES-03 |
| `math/rand` for tokens | API-DAT-02 |

### .NET (ASP.NET Core)
| Pattern | Check |
|---|---|
| `FromSqlRaw($"…")`, `SqlCommand` with concatenation | API-INJ-01 |
| controllers/actions without `[Authorize]` or with `[AllowAnonymous]` on sensitive actions | API-AUN-01 |
| `BinaryFormatter`, `TypeNameHandling.All` (Newtonsoft) | API-SRV-04 |
| `[IgnoreAntiforgeryToken]`, missing `ValidateAntiForgeryToken` | API-HTTP-02 |
| `ServerCertificateCustomValidationCallback = (…) => true` | API-HTTP-03 |
| `app.UseDeveloperExceptionPage()` outside Development | API-LOG-01 |
| `AllowAnyOrigin().AllowCredentials()` patterns | API-HTTP-01 |

### PHP (Laravel, Symfony, plain)
| Pattern | Check |
|---|---|
| `DB::raw`, `whereRaw`, `mysqli_query` with `$_GET`/`$_POST` | API-INJ-01 |
| `unserialize($_…)`, phar:// wrappers | API-SRV-04 |
| `include/require` with input (LFI/RFI) | API-SRV-02 |
| `system`, `exec`, `shell_exec`, backticks | API-INJ-03 |
| `$fillable` missing / `$guarded = []` | API-AUZ-03 |
| `APP_DEBUG=true` in production env, `phpinfo()` | API-LOG-01, API-LOG-04 |
| `==` comparisons on hashes (type juggling) | API-AUN-11 |

### Ruby (Rails)
| Pattern | Check |
|---|---|
| `where("… #{x}")`, `find_by_sql` interpolation | API-INJ-01 |
| `params.permit!`, missing strong params | API-AUZ-03 |
| `Marshal.load`, `YAML.load` (unsafe) | API-SRV-04 |
| `skip_before_action :verify_authenticity_token` | API-HTTP-02 |
| `html_safe`, `raw` on user input | WEB-XSS-01 |
| `redirect_to params[:url]` | API-SRV-07 |
| `system`, backticks, `Open3` with input | API-INJ-03 |
