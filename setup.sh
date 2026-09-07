#!/bin/bash

echo "🚀 Setting up Proctor Portal React Application..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18 or higher."
    exit 1
fi

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "⚠️  Warning: Node.js version is $NODE_VERSION. Recommended version is 18 or higher."
    echo "   Some packages may show warnings but should still work."
fi

echo "✅ Node.js version: $(node -v)"
echo "✅ npm version: $(npm -v)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
echo "   This may take a few minutes..."
echo ""

npm install --legacy-peer-deps

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Dependencies installed successfully!"
    echo ""
    echo "🎉 Setup complete! You can now run:"
    echo ""
    echo "   npm run dev     - Start development server"
    echo "   npm run build   - Build for production"
    echo "   npm run preview - Preview production build"
    echo ""
    echo "📚 The app will be available at: http://localhost:3000"
    echo ""
    echo "🔑 Demo credentials:"
    echo "   Admin:       admin / admin123"
    echo "   Vendor:      sai / sai123"
    echo "   Coordinator: coord1 / coord123"
    echo ""
else
    echo ""
    echo "❌ Installation failed. Please check the errors above."
    echo ""
    echo "💡 Troubleshooting tips:"
    echo "   1. Check your internet connection"
    echo "   2. Clear npm cache: npm cache clean --force"
    echo "   3. Try again with: npm install --legacy-peer-deps"
    echo "   4. If behind a proxy, configure npm proxy settings"
    echo ""
    exit 1
fi
