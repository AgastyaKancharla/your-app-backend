const UNIT_ALIASES = {
  g: "grm",
  gm: "grm",
  gram: "grm",
  grams: "grm",
  grm: "grm",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  l: "ltr",
  lt: "ltr",
  liter: "ltr",
  litre: "ltr",
  liters: "ltr",
  litres: "ltr",
  ltr: "ltr",
  pcs: "piece",
  pc: "piece",
  piece: "piece",
  pieces: "piece"
};

const UNIT_DEFS = {
  kg: { base: "weight", factor: 1 },
  grm: { base: "weight", factor: 0.001 },
  ltr: { base: "volume", factor: 1 },
  ml: { base: "volume", factor: 0.001 },
  piece: { base: "piece", factor: 1 }
};

const normalizeUnit = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  return UNIT_ALIASES[normalized] || normalized;
};

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
