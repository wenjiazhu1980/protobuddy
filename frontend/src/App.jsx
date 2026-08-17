import { Routes, Route, Link, useLocation } from 'react-router-dom';
import ProjectList from './pages/ProjectList.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Review from './pages/Review.jsx';
import PlanReview from './pages/PlanReview.jsx';
import Settings from './pages/Settings.jsx';

function TopBar() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <div className="topbar">
      <Link to="/" className="topbar-brand">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect width="100" height="100" rx="20" fill="#2563eb"/>
          <text x="50" y="68" fontSize="55" textAnchor="middle" fill="white" fontFamily="sans-serif" fontWeight="bold">P</text>
        </svg>
        原型协作评审平台
      </Link>
      <nav className="topbar-nav">
        <Link to="/" className={isActive('/') && location.pathname === '/' ? 'active' : ''}>项目</Link>
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <div className="app-layout">
      <TopBar />
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/project/:id" element={<Dashboard />} />
        <Route path="/project/:id/review" element={<Review />} />
        <Route path="/project/:id/plan" element={<PlanReview />} />
        <Route path="/project/:id/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}
