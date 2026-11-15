import type { Category, OrderStatus, Unit } from "./warehouse"

/**
 * The demo data of the two invented companies. Movements are generated from
 * these tables, deterministically (same ids, same quantities on every run),
 * with dates relative to the day the seed runs.
 */

/** [sku, name, category, unit, sale price, purchase cost, reorder level, opening stock, then counter sales (daysAgo:quantity …)] */
type ProductRow = [string, string, Category, Unit, number, number, number, number, string]

/** [number suffix, customer (typed in from outside), status, days ago, lines: sku×quantity …] */
type OrderRow = [number, string, OrderStatus, number, string]

export type CompanyData = { products: ProductRow[]; adjustments: [string, number, number, string][]; restocks: [string, number, number][]; orders: OrderRow[] }

export const AURORA: CompanyData = {
  products: [
    ["SCR-440", "Wood screws 4×40 mm (box of 200)", "fasteners", "box", 6.9, 3.1, 15, 60, "38:32"],
    ["SCR-660", "Wood screws 6×60 mm (box of 100)", "fasteners", "box", 8.5, 3.9, 10, 15, ""],
    ["PLG-08", "Wall plugs 8 mm (pack of 50)", "fasteners", "box", 4.2, 1.6, 20, 80, "18:46"],
    ["BLT-M8", "Hex bolts M8×50 (pack of 25)", "fasteners", "box", 7.8, 3.4, 8, 17, ""],
    ["NAL-60", "Nails 60 mm", "fasteners", "kg", 5.6, 2.2, 10, 40, "29:21"],
    ["DRL-18V", "Cordless drill 18 V", "tools", "pcs", 129, 78, 4, 9, ""],
    ["HAM-500", "Claw hammer 500 g", "tools", "pcs", 18.5, 8.9, 5, 15, "20:5"],
    ["SDR-SET", "Screwdriver set, 8 pieces", "tools", "pcs", 24.9, 11.5, 5, 5, ""],
    ["TPM-5", "Tape measure 5 m", "tools", "pcs", 9.9, 4.1, 8, 25, "27:15"],
    ["LVL-60", "Spirit level 60 cm", "tools", "pcs", 21, 9.8, 3, 4, ""],
    ["WIR-15", "Electrical wire 1.5 mm² (100 m reel)", "electrical", "pcs", 39, 22, 4, 10, "19:5"],
    ["LED-E27", "LED bulb E27 9 W", "electrical", "pcs", 3.9, 1.5, 30, 35, ""],
    ["STR-3", "Power strip, 3 sockets", "electrical", "pcs", 8.9, 3.7, 6, 20, "16:9"],
    ["TPE-19", "Insulating tape 19 mm", "electrical", "pcs", 1.8, 0.6, 25, 23, ""],
    ["PIP-16", "Multilayer pipe 16 mm", "plumbing", "m", 2.4, 1.1, 50, 200, "28:120"],
    ["FIT-12", "Brass fitting 1/2\"", "plumbing", "pcs", 3.2, 1.3, 20, 33, ""],
    ["SIL-CL", "Clear silicone sealant 280 ml", "plumbing", "pcs", 6.5, 2.8, 12, 36, "23:24"],
    ["PTF-12", "PTFE tape 12 mm", "plumbing", "pcs", 1.2, 0.4, 20, 40, ""],
    ["PNT-WH", "Wall paint, white", "paint", "l", 4.6, 2.1, 40, 150, "24:120"],
    ["ENM-BL", "Enamel paint, blue", "paint", "l", 12.8, 6.2, 5, 7, "29:7"],
    ["BRS-50", "Paint brush 50 mm", "paint", "pcs", 3.9, 1.4, 10, 30, "18:14"],
    ["ROL-22", "Paint roller 22 cm", "paint", "pcs", 7.5, 3, 6, 8, ""],
    ["GLV-L", "Work gloves, size L", "garden", "pcs", 4.5, 1.7, 15, 50, "30:30"],
    ["HOS-25", "Garden hose 25 m", "garden", "pcs", 29.9, 14.2, 3, 6, ""],
    ["BRM-01", "Broom with handle", "household", "pcs", 9.5, 4, 4, 12, "26:3"],
  ],
  // [sku, days ago, signed quantity, note]
  adjustments: [
    ["NAL-60", 34, -2, "Stocktake: damaged bags"],
    ["TPM-5", 22, 1, "Stocktake: found in the back room"],
    ["SIL-CL", 15, -1, "Leaking tube thrown away"],
  ],
  // [sku, days ago, quantity]
  restocks: [
    ["LED-E27", 28, 60],
    ["SCR-440", 25, 20],
    ["PNT-WH", 18, 60],
  ],
  orders: [
    [1, "Linden Street building site", "shipped", 40, "SCR-440×4 PLG-08×6 NAL-60×3"],
    [2, "Bellamy Architects", "shipped", 33, "LED-E27×20 STR-3×2"],
    [3, "Oak Grove Apartments", "shipped", 27, "PNT-WH×20 BRS-50×4 ROL-22×2"],
    [4, "Thornton Motorcycle Repairs", "confirmed", 19, "BLT-M8×4 SDR-SET×1"],
    [5, "Martin Fountain", "confirmed", 12, "DRL-18V×1 TPM-5×1"],
    [6, "Secret Garden Nursery", "confirmed", 8, "GLV-L×6 HOS-25×1"],
    [7, "Bassett Plumbing", "confirmed", 5, "PIP-16×30 FIT-12×10 PTF-12×5"],
    [8, "Ellen Conway", "cancelled", 9, "ENM-BL×2"],
    [9, "Linden Street building site", "draft", 3, "SCR-660×4 NAL-60×5 HAM-500×2"],
    [10, "Rainbow Preschool", "draft", 2, "LED-E27×24 TPE-19×6"],
    // More drills than in stock: confirming it is refused until goods come in.
    [11, "Moreton Renovations", "draft", 1, "DRL-18V×12 LVL-60×1"],
    [12, "Paul Richards (call back after 6 pm)", "draft", 0, "BRM-01×1 SIL-CL×2"],
  ],
}

export const HUMMINGBIRD: CompanyData = {
  products: [
    ["CND-LAV", "Soy candle, lavender", "household", "pcs", 14, 5.5, 10, 30, "20:6 9:8"],
    ["SOP-OLV", "Olive oil soap bar", "household", "pcs", 5.5, 1.9, 20, 60, "25:12 11:15 3:10"],
    ["MUG-CER", "Ceramic mug, hand painted", "household", "pcs", 18, 7.2, 6, 14, "18:4 6:5"],
    ["POT-TER", "Terracotta pot 14 cm", "garden", "pcs", 6.8, 2.4, 10, 25, "16:6"],
    ["SED-BAS", "Basil seeds", "garden", "pcs", 2.5, 0.7, 15, 40, "14:10 4:12"],
    ["BRS-WTC", "Watercolour brush set", "paint", "pcs", 16, 6.9, 4, 8, "12:3"],
  ],
  adjustments: [["MUG-CER", 8, -1, "Broken in the shop"]],
  restocks: [["SOP-OLV", 10, 30]],
  orders: [
    [1, "Hillside Farm Stay", "shipped", 15, "SOP-OLV×10 CND-LAV×4"],
    [2, "Erica Vale", "confirmed", 6, "MUG-CER×2"],
    [3, "Wisteria Bed & Breakfast", "draft", 1, "CND-LAV×6 POT-TER×4"],
  ],
}
