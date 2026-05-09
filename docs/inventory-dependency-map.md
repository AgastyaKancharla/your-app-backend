# Cloud Kitchen Inventory Dependency Map

## Reused modules

- `Ingredient` / `RawMaterial`: raw material stock, min stock, supplier fields, cost aliases.
- `PrepItem`: prep batches and raw material usage.
- `Packaging`: packaging inventory.
- `Recipe`: existing recipe links used for backward compatibility and menu availability.
- `MenuItem`: menu variants, active/availability flags, recipe link.
- `Order`: POS and online order record, now stores recipe version and cost snapshots.
- `PurchaseOrder`: supplier purchase requests, now supports explicit receiving and partial quantities.
- `Supplier`: supplier identity reused by PO receiving and price history.
- `WastageLog`: wastage records reused with movement entries.
- `cloudKitchenOperationsService`: menu availability and operations surface reused.
- `cloudInventoryController` / `inventoryRoutes`: existing cloud inventory API surface extended.

## Added modules

- `InventoryMovement`: append-only stock movement ledger for purchases, orders, wastage, prep, adjustments, and reconciliation.
- `RecipeVersion`: immutable variant-level recipe versions with raw material and prep item ingredients.
- `Reconciliation`: blind count workflow with manager approval.
- `InventoryAlert`: generated smart alerts with acknowledgement.
- `SupplierPriceHistory`: received supplier prices for trend/history.
- `inventoryMovementService`: single stock mutation gateway plus weighted average costing.
- `recipeEngineService`: variant recipe versioning and recipe costing.
- `hybridInventoryService`: order deduction planning, override evaluation, prep production, PO receiving, reconciliation, analytics, suggestions.
- `inventoryAlertService`: reusable alert generator.

## Existing logic replaced by movement-driven updates

- POS/cloud order deductions create `order_deduction` movements.
- Prep production consumes raw materials with `prep_consumption` and creates `prep_production`.
- Purchase receiving creates `purchase` movements and updates weighted average cost.
- Wastage creates `wastage` movements.
- Stock adjustments and approved reconciliations create adjustment movements.

## Still intentionally compatible

- Legacy recipe APIs continue to read/write `Recipe`.
- Legacy ingredient aliases (`quantity`, `stock`, `currentStock`, `pricePerUnit`, `costPerUnit`) are kept in sync.
- Existing supplier, purchase order, and cloud dashboard routes remain mounted at their current paths.
