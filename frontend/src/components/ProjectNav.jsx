import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { projectTabs } from './projectTabs.js';
import { api } from '../api.js';

/**
 * 项目内 Tab 导航（概览/评审/方案/任务/设置）。
 * sticky 在 TopBar 下方，移动端改为横向可滚动 tab 条。
 * tasks/new、tasks/:taskId 归属「任务」Tab（NavLink 前缀匹配）。
 */
export default function ProjectNav({ projectId }) {
  const location = useLocation();
  const [projectName, setProjectName] = useState('');

  useEffect(() => {
    let alive = true;
    if (!projectId) return;
    api.getProject(projectId)
      .then((p) => alive && setProjectName(p.name || ''))
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  if (!projectId) return null;
  const tabs = projectTabs(projectId);

  return (
    <nav className="project-nav">
      {projectName && <span className="project-nav-crumb">{projectName}</span>}
      <div className="project-nav-tabs">
        {tabs.map((t) => (
          <NavLink
            key={t.key}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              'project-nav-tab' + (isActive ? ' active' : '')
            }
            // tasks 子路由（/tasks/new、/tasks/:taskId）也归属任务 Tab
            isActive={() => {
              if (t.key === 'tasks') return location.pathname.startsWith(t.to);
              if (t.end) return location.pathname === t.to;
              return location.pathname.startsWith(t.to) &&
                !tabs.some((o) => o !== t && location.pathname.startsWith(o.to) && o.to.length > t.to.length);
            }}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
