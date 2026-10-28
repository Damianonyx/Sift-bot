// Leaf module: rule validation must not import the risk client, which imports
// persistence errors and otherwise creates an entry-point-dependent ESM cycle.
export const RISK_FIELDS = Object.freeze(['liquidityProtection', 'developerHolding', 'buyingCoordination']);
