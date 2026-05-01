const UNIT_DEFS = {
  kg: { base: "g", factor: 1000 },
  g: { base: "g", factor: 1 },
  l: { base: "ml", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  pcs: { base: "pcs", factor: 1 }
};

const normalizeUnit = (value = "") => String(value || "").trim().toLowerCase();

const getUnitMeta = (unit) => UNIT_DEFS[normalizeUnit(unit)] || null;

const convertBetweenUnits = (value, fromUnit, toUnit) => {
  const fromMeta = getUnitMeta(fromUnit);
  const toMeta = getUnitMeta(toUnit);

  if (!fromMeta || !toMeta || fromMeta.base !== toMeta.base) {
    return null;
  }

  const numericValue = Number(value || 0);
  const baseValue = numericValue * fromMeta.factor;
  return baseValue / toMeta.factor;
};

const isBelowMinStock = ({ quantity, unit, minStock, minStockUnit }) => {
  const normalizedUnit = normalizeUnit(unit) || "kg";
  const normalizedMinUnit = normalizeUnit(minStockUnit) || normalizedUnit;
  const convertedMin = convertBetweenUnits(minStock, normalizedMinUnit, normalizedUnit);
  const safeMin = Number.isFinite(convertedMin) ? convertedMin : Number(minStock || 0);
  return Number(quantity || 0) <= safeMin;
};

module.exports = {
  normalizeUnit,
  convertBetweenUnits,
  isBelowMinStock
};
