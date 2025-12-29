# Security Policy

## Known Security Issues

### vm2 Critical Vulnerability

**Status:** Cannot be fixed without breaking changes to jsreport-core

#### Description
The project depends on `jsreport-core@2.10.x`, which uses `vm2@3.8.3` as a transitive dependency. The vm2 library has been deprecated and contains critical security vulnerabilities related to sandbox escape and arbitrary code execution.

#### Impact
- **Risk Level:** Critical
- **Affected Component:** PDF generation via jsreport-core
- **Attack Vector:** Only exploitable if untrusted code is executed within the PDF generation context

#### Mitigation Status
- ✅ The application does not execute untrusted user code in the jsreport environment
- ✅ All PDF templates are defined in the application code, not user input
- ✅ HTML content is properly sanitized using the `escapeHtml()` method
- ⚠️ The vm2 vulnerability remains as a transitive dependency

#### Why Can't This Be Fixed?
1. jsreport-core v2.10.1 is the latest version in the v2 series
2. There is no v3 of jsreport-core that removes the vm2 dependency
3. The vm2 library is unmaintained and the author recommends migrating to `isolated-vm`
4. Replacing vm2 with isolated-vm would require changes to jsreport-core itself
5. Upgrading via `npm audit fix --force` would downgrade to jsreport-core@1.5.1, breaking functionality

#### Recommendations
1. **For Development Use:** The current implementation is acceptable since the application controls all code execution
2. **For Production Use:** Consider one of the following alternatives:
   - Use a different PDF generation library (e.g., Puppeteer, Playwright PDF, PDFKit)
   - Run the PDF generation service in an isolated container with restricted permissions
   - Monitor jsreport for updates that remove the vm2 dependency
   - Contribute to jsreport to help migrate away from vm2

#### Alternative PDF Generation Libraries
If the vm2 vulnerability is a blocker, consider these alternatives:

- **Puppeteer** - Headless Chrome automation
- **Playwright PDF** - Modern browser automation
- **PDFKit** - Pure JavaScript PDF generation
- **pdfmake** - Client/server-side PDF generation
- **jsPDF** - JavaScript PDF generation

## Security Updates Applied

### ✅ Fixed Issues
1. **lodash.get@4.4.2** → Overridden with lodash@4.17.21
2. **lodash.omit@4.5.0** → Overridden with lodash@4.17.21
3. **lodash.set** → Overridden with lodash@4.17.21
4. **uuid@3.3.2** → Overridden with uuid@9.0.0
5. **axios@0.19.2** → Overridden with axios@1.6.0
6. **ajv** → Overridden with ajv@6.12.6
7. **nanoid** → Overridden with nanoid@3.3.8
8. **ms** → Overridden with ms@2.1.3
9. **async** → Overridden with async@3.2.6
10. **nconf** → Overridden with nconf@0.13.0
11. **nodemailer@6.9.0** → Updated to nodemailer@7.0.12

### Configuration Updates
- Fixed `.npmrc` to use proper environment variable documentation instead of deprecated config option
- Added npm overrides in `package.json` to force secure versions of transitive dependencies

## Reporting a Vulnerability

If you discover a security vulnerability in this project (excluding the known vm2 issue), please report it by opening a GitHub issue or contacting the maintainers directly.

### What to Include
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fixes (if any)

## Security Best Practices

When using this application:

1. **Environment Variables:** Never commit `.env` files with real credentials
2. **API Tokens:** Rotate Invoice Ninja API tokens regularly
3. **Email Credentials:** Use app-specific passwords when possible
4. **Network Security:** Run behind a firewall in production
5. **Container Isolation:** Consider running in Docker with restricted permissions
6. **Input Validation:** All user input is sanitized before PDF generation
7. **Dependencies:** Keep dependencies updated with `npm update`

## Security Checklist

- [x] Deprecated package warnings resolved where possible
- [x] Direct dependencies updated to latest secure versions
- [x] npm overrides configured for transitive dependencies
- [x] HTML sanitization implemented in PDF generation
- [x] No user code execution in application
- [ ] vm2 vulnerability (waiting for jsreport update)

## Contact

For security concerns, please open an issue on GitHub or contact the repository maintainer.
