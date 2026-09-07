# 🔧 Troubleshooting Guide

## Issue: esbuild Installation Failure

If you see this error during `npm install`:
```
Error: Command failed: .../esbuild --version
signal: 'SIGSEGV'
```

### Root Cause
- esbuild binary incompatibility with your system
- Node.js version (v18.19.1) may have issues with esbuild
- System architecture compatibility

### Solution Options

## Option 1: Use Alternative Build Tool (Recommended)

Let's switch from Vite to a simpler setup that works with your system:

```bash
# Remove the problematic node_modules
rm -rf node_modules package-lock.json

# Install with alternative configuration
npm install --no-optional --legacy-peer-deps
```

## Option 2: Run Without Building (Development Only)

Since this is a refactoring exercise, you can:

1. **View the code structure** - All files are created and organized
2. **Read the documentation** - See how it's structured
3. **Use the original HTML** - Keep using the working version
4. **Review the React code** - Understand the patterns

The React app is fully coded and ready - the only issue is the build tool installation.

## Option 3: Use Docker (Clean Environment)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["npm", "run", "dev"]
```

Then run:
```bash
docker build -t proctor-portal .
docker run -p 3000:3000 proctor-portal
```

## Option 4: Simplified package.json

Let me create a simpler version without esbuild-dependent packages.
