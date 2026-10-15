export type EntityContext = 'Tenant' | 'User' | 'Other';

export interface ScopeUser {
  userId?: number;
  id?: number;
  name?: string;
  email?: string;
  role?: string;
  roleLevel?: string | null;
  tenantId?: string | null;
  activeTenantId?: string | null;
  groupId?: string | null;
  departmentId?: string | null;
}

/**
 * Returns the effective tenant ID for the user context.
 * Prioritizes activeTenantId (from x-tenant-id switcher) over the home tenantId.
 */
export function effectiveTenantId(user: any): string | null {
  if (!user) return null;
  return user.activeTenantId ?? user.tenantId ?? null;
}

/**
 * Applies hierarchical multi-tenancy scoping rules to a Prisma `where` clause.
 * Returns a new object without mutating `baseWhere` in place.
 *
 * Hierarchy levels:
 * - L0_PLATFORM: Super-admin / platform operator (cross-tenant access)
 * - L1_GROUP: Multi-company / group manager (all companies within their group)
 * - L2_COMPANY: Company / tenant manager (all departments/agents within their tenant)
 * - L3_DEPARTMENT: Department manager (currently scoped to tenant, granular scoping in Phase 3)
 * - L4_AGENT: Individual agent / team member (scoped to tenant)
 */
export function applyTenantScope(
  baseWhere: any = {},
  user: any,
  entityContext?: 'Tenant' | 'User' | 'Other'
): any {
  if (!user) {
    return { ...baseWhere };
  }

  // If an active tenant override is present (via switcher), scope strictly to it for all levels
  if (user.activeTenantId) {
    if (entityContext === 'Tenant') {
      return {
        ...baseWhere,
        id: user.activeTenantId,
      };
    }
    return {
      ...baseWhere,
      tenantId: user.activeTenantId,
    };
  }

  const roleLevel = user.roleLevel || (user.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');

  switch (roleLevel) {
    case 'L0_PLATFORM':
      return { ...baseWhere };

    case 'L1_GROUP':
      if (entityContext === 'Tenant') {
        return {
          ...baseWhere,
          groupId: user.groupId || null,
        };
      }
      return {
        ...baseWhere,
        Tenant: {
          groupId: user.groupId || null,
        },
      };

    case 'L2_COMPANY':
    case 'L3_DEPARTMENT':
    case 'L4_AGENT':
    default:
      if (entityContext === 'Tenant') {
        return {
          ...baseWhere,
          id: user.tenantId || null,
        };
      }
      return {
        ...baseWhere,
        tenantId: user.tenantId || null,
      };
  }
}
