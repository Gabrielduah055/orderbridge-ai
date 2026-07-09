export const userRoles = ["super_admin", "restaurant_admin"] as const;

export type UserRole = (typeof userRoles)[number];
