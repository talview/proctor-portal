#!/bin/bash

echo "🔧 Alternative Setup for Proctor Portal React"
echo "   (For systems with esbuild compatibility issues)"
echo ""

# Clean previous attempts
echo "🧹 Cleaning previous installation attempts..."
rm -rf node_modules package-lock.json

# Use the simplified package.json
echo "📦 Using simplified dependencies..."
cp package.simple.json package.json

# Clear npm cache
echo "🗑️  Clearing npm cache..."
npm cache clean --force

# Install with workarounds
echo "📥 Installing dependencies (this may take a few minutes)..."
npm install --no-optional --legacy-peer-deps --verbose

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Installation successful!"
    echo ""
    echo "🎉 You can now run:"
    echo "   npm run dev"
    echo ""
else
    echo ""
    echo "❌ Installation still failed."
    echo ""
    echo "Alternative Options:"
    echo ""
    echo "1️⃣  View the code structure (already created)"
    echo "   All React files are in place - you can review them"
    echo ""
    echo "2️⃣  Use the original HTML version"
    echo "   cd ../proctor-portal"
    echo "   python3 -m http.server 8000"
    echo ""
    echo "3️⃣  Upgrade Node.js to v20+"
    echo "   The app requires Node.js 20+ for full compatibility"
    echo ""
    echo "4️⃣  Use online editors"
    echo "   - CodeSandbox: https://codesandbox.io"
    echo "   - StackBlitz: https://stackblitz.com"
    echo ""
fi
