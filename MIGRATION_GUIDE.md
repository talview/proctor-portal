# Migration Guide: HTML → React

This document explains how the original HTML application was refactored into a modern React application.

## 🏗️ Architecture Changes

### Before (HTML)
- **Single 6,000+ line HTML file** with inline JavaScript
- Global state in variables
- jQuery-style DOM manipulation
- Inline event handlers
- Mixed concerns (UI, logic, data)

### After (React)
- **Modular component-based architecture**
- Centralized state management (Zustand)
- Declarative UI updates
- Separation of concerns
- Type-safe with TypeScript

## 📦 Key Refactoring Decisions

### 1. **State Management: Zustand**
**Why Zustand over Redux/Context?**
- Simpler API, less boilerplate
- No providers needed
- Better performance
- Easy to learn

**Example:**
```typescript
// Before (HTML - global variables)
let currentUser = null;
let proctors = [];

// After (React - Zustand store)
const useAuthStore = create((set) => ({
  user: null,
  login: async (username, password) => {
    const user = await authService.login(username, password);
    set({ user });
  }
}));
```

### 2. **Data Fetching: TanStack Query**
**Why React Query?**
- Automatic caching
- Background refetching
- Loading/error states handled
- Optimistic updates

**Example:**
```typescript
// Before (HTML - manual fetch)
async function loadProctors() {
  showLoader();
  const response = await fetch('/api/proctors');
  proctors = await response.json();
  renderProctors();
  hideLoader();
}

// After (React - React Query)
const { data, isLoading } = useQuery({
  queryKey: ['proctors'],
  queryFn: () => proctorService.getAll()
});
```

### 3. **Routing: React Router v6**
**Why React Router?**
- Client-side routing (SPA)
- Protected routes
- Nested routes
- URL state management

**Example:**
```typescript
// Before (HTML - manual page switching)
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  document.getElementById(`page-${pageId}`).style.display = 'block';
}

// After (React - declarative routing)
<Routes>
  <Route path="/" element={<DashboardPage />} />
  <Route path="/proctors" element={<ProctorsPage />} />
</Routes>
```

### 4. **Styling: Tailwind CSS**
**Why Tailwind over inline styles?**
- Utility-first approach
- Consistent design system
- Smaller bundle size
- Better maintainability

**Example:**
```html
<!-- Before (HTML - inline styles) -->
<div style="background:#181c27;border:1px solid #2d3348;border-radius:10px;padding:18px;">

<!-- After (React - Tailwind classes) -->
<div className="bg-surface border border-border rounded-lg p-4">
```

## 📂 File Structure Mapping

### Original HTML Structure
```
proctor-portal/
├── index.html (6,128 lines - everything in one file)
│   ├── HTML structure
│   ├── CSS styles
│   ├── JavaScript logic
│   └── API calls
├── sign-nda.html
└── upload-docs.html
```

### New React Structure
```
proctor-portal-react/
├── src/
│   ├── components/         # Reusable UI pieces
│   │   └── layout/
│   │       ├── MainLayout.tsx
│   │       ├── Sidebar.tsx
│   │       └── Topbar.tsx
│   ├── pages/              # Route-based pages
│   │   ├── LoginPage.tsx
│   │   ├── DashboardPage.tsx
│   │   ├── ProctorsPage.tsx
│   │   └── ...
│   ├── services/           # API layer
│   │   ├── supabase.ts
│   │   ├── auth.ts
│   │   └── proctor.ts
│   ├── stores/             # State management
│   │   └── auth.ts
│   ├── types/              # TypeScript definitions
│   │   └── index.ts
│   ├── App.tsx             # Root component
│   └── main.tsx            # Entry point
```

## 🔄 Component Extraction Examples

### Example 1: Login Form

**Before (HTML):**
```html
<div id="loginScreen">
  <div class="login-card">
    <input type="text" id="lu"/>
    <input type="password" id="lp"/>
    <button onclick="doLogin()">Sign In</button>
  </div>
</div>

<script>
function doLogin() {
  const username = document.getElementById('lu').value;
  const password = document.getElementById('lp').value;
  // ... validation and API call
}
</script>
```

**After (React):**
```typescript
export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { login } = useAuthStore();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await login(username, password);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={username} onChange={(e) => setUsername(e.target.value)} />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Sign In</button>
    </form>
  );
}
```

### Example 2: Sidebar Navigation

**Before (HTML):**
```html
<aside class="sidebar">
  <nav id="sNav"></nav>
</aside>

<script>
function renderNav() {
  const nav = document.getElementById('sNav');
  nav.innerHTML = navItems.map(item => `
    <div class="nav-item" onclick="navigate('${item.path}')">
      ${item.icon} ${item.label}
    </div>
  `).join('');
}
</script>
```

**After (React):**
```typescript
export default function Sidebar() {
  return (
    <aside className="sidebar">
      <nav>
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => 
              isActive ? 'nav-item active' : 'nav-item'
            }
          >
            {item.icon} {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
```

## 🎯 Benefits of the Refactor

### 1. **Maintainability**
- Code is organized into logical modules
- Single responsibility per file
- Easy to locate and fix bugs

### 2. **Scalability**
- Add new features without touching existing code
- Reusable components across pages
- Easy to add new pages/routes

### 3. **Type Safety**
- TypeScript catches errors at compile time
- Auto-completion in IDEs
- Self-documenting code

### 4. **Performance**
- React's virtual DOM for efficient updates
- Code splitting with React Router
- React Query's intelligent caching

### 5. **Developer Experience**
- Hot module replacement (instant updates)
- Better debugging tools (React DevTools)
- Modern tooling (Vite, ESLint, Prettier)

### 6. **Testing**
- Unit test components in isolation
- Mock services easily
- Integration tests with React Testing Library

## 🚀 Migration Strategy

### Phase 1: Foundation (✅ Complete)
- Set up React project structure
- Configure TypeScript
- Set up routing
- Create layout components
- Implement authentication

### Phase 2: Core Features (Next)
- Build reusable Table component
- Implement Proctors page
- Create form components
- Add search/filter functionality

### Phase 3: Onboarding Workflow
- Build multi-step forms
- Implement file upload
- Create evaluation system
- Add coordinator workspace

### Phase 4: Public Forms
- Refactor NDA signing page
- Refactor document upload page
- Create interview select form

### Phase 5: Advanced Features
- CSV import/export
- Bulk operations
- Real-time updates
- Notifications system

### Phase 6: Polish & Launch
- Error handling
- Loading states
- Responsive design
- Performance optimization
- Testing

## 💡 Tips for Future Development

### 1. **Component Design**
- Keep components small and focused
- Use composition over props drilling
- Extract reusable logic into custom hooks

### 2. **State Management**
- Use local state when possible
- Zustand for global app state
- React Query for server state
- URL for navigation state

### 3. **Performance**
- Use React.memo for expensive components
- Lazy load routes with React.lazy
- Optimize re-renders with useCallback/useMemo
- Monitor bundle size

### 4. **Code Quality**
- Write TypeScript types for everything
- Use ESLint and Prettier
- Add unit tests for critical logic
- Document complex components

## 📚 Learning Resources

- [React Documentation](https://react.dev)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [TanStack Query](https://tanstack.com/query/latest)
- [Zustand](https://docs.pmnd.rs/zustand/getting-started/introduction)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [React Router](https://reactrouter.com/)

## 🤔 FAQs

**Q: Why not use Redux?**
A: Zustand is simpler, has less boilerplate, and is sufficient for this application's needs.

**Q: Why Vite instead of Create React App?**
A: Vite is much faster, has better developer experience, and CRA is no longer maintained.

**Q: Should we migrate everything at once?**
A: No! Migrate page by page. You can even run both apps side-by-side during transition.

**Q: What about the public forms (NDA, upload)?**
A: These will be separate routes in the React app, but can be extracted as standalone pages if needed.

**Q: How do we handle backward compatibility?**
A: The API (Supabase) remains the same, so both old and new UIs can coexist during migration.
