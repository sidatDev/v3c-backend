export const RESOURCES = {
  DASHBOARD: 'dashboard',
  CONVERSATIONS: 'conversations',
  LEADS: 'leads',
  WIDGET: 'widget',
  INTEGRATIONS: 'integrations',
  KNOWLEDGE_BASE: 'knowledge_base',
  TEAM: 'team',
  ROLES: 'roles',
  DOMAIN: 'domain',
  BILLING: 'billing',
  ACCOUNT: 'account',
  NOTIFICATIONS: 'notifications',
  AI_SEARCH: 'ai_search',
} as const;

export const ACTIONS = {
  VIEW: 'view',
  CREATE: 'create',
  EDIT: 'edit',
  DELETE: 'delete',
  MANAGE: 'manage',
} as const;

export type Resource = typeof RESOURCES[keyof typeof RESOURCES];
export type Action = typeof ACTIONS[keyof typeof ACTIONS];

export interface PermissionDefinition {
  resource: Resource;
  action: Action;
  description: string;
}

export const DEFAULT_PERMISSIONS: PermissionDefinition[] = [
  // Dashboard
  { resource: 'dashboard', action: 'view', description: 'View dashboard metrics and charts' },
  { resource: 'dashboard', action: 'manage', description: 'Full access to dashboard' },

  // Conversations
  { resource: 'conversations', action: 'view', description: 'View conversation history' },
  { resource: 'conversations', action: 'manage', description: 'Manage and delete conversations' },

  // Leads
  { resource: 'leads', action: 'view', description: 'View captured leads' },
  { resource: 'leads', action: 'create', description: 'Create new leads manually' },
  { resource: 'leads', action: 'edit', description: 'Update lead status and details' },
  { resource: 'leads', action: 'manage', description: 'Full management of leads and notes' },

  // Manage Widget
  { resource: 'widget', action: 'view', description: 'View widget settings' },
  { resource: 'widget', action: 'edit', description: 'Modify widget appearance and controls' },
  { resource: 'widget', action: 'manage', description: 'Full access to configure and toggle widget' },

  // Integrations
  { resource: 'integrations', action: 'view', description: 'View integrations and logs' },
  { resource: 'integrations', action: 'manage', description: 'Full access to configure integrations (Super Admin)' },

  // Knowledge Base
  { resource: 'knowledge_base', action: 'view', description: 'View sitemaps and articles' },
  { resource: 'knowledge_base', action: 'create', description: 'Add new sitemaps/documents' },
  { resource: 'knowledge_base', action: 'edit', description: 'Edit sitemap settings/personas' },
  { resource: 'knowledge_base', action: 'manage', description: 'Full access to knowledge base and tester' },

  // Team
  { resource: 'team', action: 'view', description: 'View team members' },
  { resource: 'team', action: 'manage', description: 'Invite, edit, and disable team members' },

  // Roles & Permissions
  { resource: 'roles', action: 'view', description: 'View roles and permissions' },
  { resource: 'roles', action: 'manage', description: 'Create and edit roles, toggle permissions' },

  // Domain Settings
  { resource: 'domain', action: 'view', description: 'View domains and keys' },
  { resource: 'domain', action: 'manage', description: 'Configure white-label logos and manage API keys' },

  // Billing
  { resource: 'billing', action: 'view', description: 'View plans and billing history' },
  { resource: 'billing', action: 'manage', description: 'Manage plans and subscriptions' },

  // Account
  { resource: 'account', action: 'view', description: 'View own account settings' },
  { resource: 'account', action: 'edit', description: 'Update own profile and password' },

  // Notifications
  { resource: 'notifications', action: 'view', description: 'View notifications' },
  { resource: 'notifications', action: 'manage', description: 'Clear and configure notifications' },

  // AI Search
  { resource: 'ai_search', action: 'view', description: 'View AI search setups and logs' },
  { resource: 'ai_search', action: 'manage', description: 'Configure websites, keys, limits and trigger crawl jobs' },
];
