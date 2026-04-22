# Security Audit Report

This document outlines the security measures implemented in the AESOP Afghanistan application.

## Security Measures Implemented

### 1. Input Validation & Sanitization

- **Email Validation**: RFC 5322 compliant email validation with length limits (max 254 characters)
- **Email Sanitization**: Removes newlines, carriage returns, and control characters to prevent header injection
- **Token Validation**: Validates token format (64-character hex string) before processing
- **Input Length Limits**: JSON payloads limited to 10KB to prevent DoS attacks

### 2. Injection Attack Prevention

- **Email Header Injection**: All email addresses and subjects are sanitized before being sent
- **XSS Prevention**: 
  - All user input is sanitized
  - Frontend uses `textContent` instead of `innerHTML` for user-generated content
  - Content Security Policy headers prevent inline script execution
- **Path Traversal**: Uses `path.join()` with `__dirname` to prevent directory traversal
- **Google Sheets**: Column indices are validated to prevent out-of-bounds access

### 3. Rate Limiting

- **Magic Link Requests**: 5 requests per 15 minutes per IP address
- **Token Verification**: 10 attempts per 15 minutes per IP address
- Rate limit headers included in responses
- Prevents brute force attacks and email spam

### 4. Information Disclosure Prevention

- **Email Enumeration**: Always returns success message regardless of email existence
- **Error Messages**: Generic error messages that don't expose internal structure
- **Error Logging**: Only logs error messages, not full stack traces or sensitive data
- **Secrets**: Never exposed in error messages or logs

### 5. Security Headers

Implemented via Helmet.js:
- **Content Security Policy**: Restricts resource loading to prevent XSS
- **HSTS**: Forces HTTPS connections
- **X-Content-Type-Options**: Prevents MIME type sniffing
- **X-Frame-Options**: Prevents clickjacking
- **X-XSS-Protection**: Browser XSS filter
- **Referrer Policy**: Controls referrer information

### 6. Token Security

- **Cryptographically Secure**: Uses `crypto.randomBytes(32)` for token generation
- **Single Use**: Tokens are marked as used after verification
- **Expiration**: 15-minute expiration time
- **Format Validation**: Tokens must be exactly 64 hex characters
- **Secure Transmission**: Tokens sent via email link, then POSTed to API (not exposed in API logs)

### 7. Authentication Flow Security

- **Magic Link Flow**: 
  1. User requests magic link with email
  2. System checks email against Google Sheet (no enumeration)
  3. If found, generates secure token and sends email
  4. User clicks link in email (GET request to landing page)
  5. Landing page POSTs token to API for verification
  6. Token verified and marked as used
  7. User authenticated

### 8. Secrets Management

- **File-based**: `config/secrets.json` (gitignored)
- **Environment Variables**: Fallback to environment variables for production
- **No Hardcoding**: No secrets hardcoded in source code
- **Validation**: Secrets validated before use

### 9. Google Sheets Integration Security

- **Read-only Access**: Service account has read-only permissions
- **Column Validation**: Column indices validated before access
- **Error Handling**: Malformed rows are skipped without exposing errors
- **Input Sanitization**: Email addresses sanitized before comparison

### 10. Email Security

- **SMTP Configuration**: Supports multiple providers (SMTP, SendGrid, Gmail)
- **Header Sanitization**: Email headers sanitized to prevent injection
- **From Address**: Configurable from address
- **Error Handling**: Email errors don't expose recipient information

## Known Limitations & Recommendations

### Current Limitations

1. **In-Memory Token Storage**: Tokens stored in memory (lost on restart)
   - **Recommendation**: Use Redis for production deployments

2. **In-Memory Rate Limiting**: Rate limits reset on server restart
   - **Recommendation**: Use Redis-based rate limiting for production

3. **No CSRF Protection**: Currently not needed (no authenticated state), but should be added when implementing sessions

4. **No Session Management**: Magic link verification returns email but doesn't create session
   - **Recommendation**: Implement secure session management (e.g., httpOnly cookies)

### Production Recommendations

1. **Use Redis** for token storage and rate limiting
2. **Implement Sessions** with secure, httpOnly cookies
3. **Add CSRF Protection** when implementing authenticated endpoints
4. **Set up Monitoring** for suspicious activity (failed verifications, rate limit hits)
5. **Regular Security Audits** of dependencies
6. **Use HTTPS Only** (already configured in Fly.io)
7. **Implement Logging** to external service (avoid logging sensitive data)
8. **Regular Dependency Updates** to patch vulnerabilities

## Security Checklist

- [x] Input validation and sanitization
- [x] Email header injection prevention
- [x] XSS prevention
- [x] Rate limiting
- [x] Email enumeration prevention
- [x] Secure token generation
- [x] Token expiration
- [x] Single-use tokens
- [x] Security headers
- [x] Error message sanitization
- [x] Secrets management
- [ ] Session management (TODO)
- [ ] CSRF protection (TODO when sessions added)
- [ ] Redis for production (recommended)

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly. Do not create a public GitHub issue.
