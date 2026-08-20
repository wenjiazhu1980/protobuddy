// 项目内 Tab 导航共享常量。TopBar 汉堡菜单与 ProjectNav 共用，保证两处链接一致。
export const projectTabs = (id) => [
  { key: 'overview', label: '概览', to: `/project/${id}`, end: true },
  { key: 'review', label: '评审', to: `/project/${id}/review` },
  { key: 'plan', label: '方案', to: `/project/${id}/plan` },
  { key: 'tasks', label: '任务', to: `/project/${id}/tasks` },
  { key: 'settings', label: '设置', to: `/project/${id}/settings` },
];
