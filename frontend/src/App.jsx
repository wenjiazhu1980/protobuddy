import { useState } from 'react';
import { Routes, Route, Link, useLocation, matchPath } from 'react-router-dom';
import ProjectList from './pages/ProjectList.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Review from './pages/Review.jsx';
import PlanReview from './pages/PlanReview.jsx';
import Settings from './pages/Settings.jsx';
import Tasks from './pages/Tasks.jsx';
import TaskDetail from './pages/TaskDetail.jsx';
import { OwnerAuthProvider } from './components/OwnerAuthContext.jsx';
import ProjectNav from './components/ProjectNav.jsx';
import { projectTabs } from './components/projectTabs.js';
import { ToastProvider } from './components/ToastContext.jsx';

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function TopBar() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  // 提取项目 id（若在项目内路由），汉堡菜单追加项目 Tab
  const projMatch = matchPath('/project/:id/*', location.pathname) || matchPath('/project/:id', location.pathname);
  const projectId = projMatch?.params?.id;
  const tabs = projectId ? projectTabs(projectId) : [];

  return (
    <div className="topbar">
      <Link to="/" className="topbar-brand">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect width="100" height="100" rx="20" fill="#18181b"/>
          <text x="50" y="68" fontSize="55" textAnchor="middle" fill="white" fontFamily="sans-serif" fontWeight="bold">P</text>
        </svg>
        原型协作评审平台
      </Link>
      <nav className="topbar-nav">
        <Link to="/" className={isActive('/') && location.pathname === '/' ? 'active' : ''}>项目</Link>
      </nav>
      <button
        className="hamburger-btn"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="菜单"
        aria-expanded={menuOpen}
      >
        {menuOpen ? <CloseIcon /> : <HamburgerIcon />}
      </button>
      {menuOpen && (
        <div className="mobile-menu" onClick={() => setMenuOpen(false)}>
          <Link to="/" className="mobile-menu-item">项目</Link>
          {tabs.map((t) => (
            <Link key={t.key} to={t.to} className="mobile-menu-item">{t.label}</Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const inProject = matchPath('/project/:id/*', location.pathname) || matchPath('/project/:id', location.pathname);

  return (
    <OwnerAuthProvider>
      <ToastProvider>
        <div className="app-layout">
          <TopBar />
          {inProject && <ProjectNav />}
          <Routes>
            <Route path="/" element={<ProjectList />} />
            <Route path="/project/:id" element={<Dashboard />} />
            <Route path="/project/:id/review" element={<Review />} />
            <Route path="/project/:id/plan" element={<PlanReview />} />
            <Route path="/project/:id/settings" element={<Settings />} />
            <Route path="/project/:id/tasks" element={<Tasks />} />
            <Route path="/project/:id/tasks/new" element={<TaskDetail />} />
            <Route path="/project/:id/tasks/:taskId" element={<TaskDetail />} />
          </Routes>
        </div>
      </ToastProvider>
    </OwnerAuthProvider>
  );
}
