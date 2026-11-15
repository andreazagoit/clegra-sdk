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
    ["VIT-440", "Wood screws 4×40 mm (box of 200)", "fasteners", "box", 6.9, 3.1, 15, 60, "38:32"],
    ["VIT-660", "Wood screws 6×60 mm (box of 100)", "fasteners", "box", 8.5, 3.9, 10, 15, ""],
    ["TAS-08", "Wall plugs 8 mm (pack of 50)", "fasteners", "box", 4.2, 1.6, 20, 80, "18:46"],
    ["BUL-M8", "Hex bolts M8×50 (pack of 25)", "fasteners", "box", 7.8, 3.4, 8, 17, ""],
    ["CHI-60", "Nails 60 mm", "fasteners", "kg", 5.6, 2.2, 10, 40, "29:21"],
    ["TRA-18V", "Cordless drill 18 V", "tools", "pcs", 129, 78, 4, 9, ""],
    ["MAR-500", "Claw hammer 500 g", "tools", "pcs", 18.5, 8.9, 5, 15, "20:5"],
    ["CAC-SET", "Screwdriver set, 8 pieces", "tools", "pcs", 24.9, 11.5, 5, 5, ""],
    ["MET-5", "Tape measure 5 m", "tools", "pcs", 9.9, 4.1, 8, 25, "27:15"],
    ["LIV-60", "Spirit level 60 cm", "tools", "pcs", 21, 9.8, 3, 4, ""],
    ["CAV-15", "Electrical wire 1.5 mm² (100 m reel)", "electrical", "pcs", 39, 22, 4, 10, "19:5"],
    ["LED-E27", "LED bulb E27 9 W", "electrical", "pcs", 3.9, 1.5, 30, 35, ""],
    ["PRE-3", "Power strip, 3 sockets", "electrical", "pcs", 8.9, 3.7, 6, 20, "16:9"],
    ["NAS-19", "Insulating tape 19 mm", "electrical", "pcs", 1.8, 0.6, 25, 23, ""],
    ["TUB-16", "Multilayer pipe 16 mm", "plumbing", "m", 2.4, 1.1, 50, 200, "28:120"],
    ["RAC-12", "Brass fitting 1/2\"", "plumbing", "pcs", 3.2, 1.3, 20, 33, ""],
    ["SIL-TR", "Clear silicone sealant 280 ml", "plumbing", "pcs", 6.5, 2.8, 12, 36, "23:24"],
    ["TEF-12", "PTFE tape 12 mm", "plumbing", "pcs", 1.2, 0.4, 20, 40, ""],
    ["IDR-BI", "Wall paint, white", "paint", "l", 4.6, 2.1, 40, 150, "24:120"],
    ["SMA-BL", "Enamel paint, blue", "paint", "l", 12.8, 6.2, 5, 7, "29:7"],
    ["PEN-50", "Paint brush 50 mm", "paint", "pcs", 3.9, 1.4, 10, 30, "18:14"],
    ["RUL-22", "Paint roller 22 cm", "paint", "pcs", 7.5, 3, 6, 8, ""],
    ["GUA-L", "Work gloves, size L", "garden", "pcs", 4.5, 1.7, 15, 50, "30:30"],
    ["TUB-GI", "Garden hose 25 m", "garden", "pcs", 29.9, 14.2, 3, 6, ""],
    ["SCO-SA", "Broom with handle", "household", "pcs", 9.5, 4, 4, 12, "26:3"],
  ],
  // [sku, days ago, signed quantity, note]
  adjustments: [
    ["CHI-60", 34, -2, "Stocktake: damaged bags"],
    ["MET-5", 22, 1, "Stocktake: found in the back room"],
    ["SIL-TR", 15, -1, "Leaking tube thrown away"],
  ],
  // [sku, days ago, quantity]
  restocks: [
    ["LED-E27", 28, 60],
    ["VIT-440", 25, 20],
    ["IDR-BI", 18, 60],
  ],
  orders: [
    [1, "Cantiere Via dei Tigli", "shipped", 40, "VIT-440×4 TAS-08×6 CHI-60×3"],
    [2, "Studio Arch. Bellandi", "shipped", 33, "LED-E27×20 PRE-3×2"],
    [3, "Condominio Le Querce", "shipped", 27, "IDR-BI×20 PEN-50×4 RUL-22×2"],
    [4, "Officina Moto Sartori", "confirmed", 19, "BUL-M8×4 CAC-SET×1"],
    [5, "Mario Fontana", "confirmed", 12, "TRA-18V×1 MET-5×1"],
    [6, "Vivaio Il Giardino Segreto", "confirmed", 8, "GUA-L×6 TUB-GI×1"],
    [7, "Idraulica Bassi", "confirmed", 5, "TUB-16×30 RAC-12×10 TEF-12×5"],
    [8, "Elena Conti", "cancelled", 9, "SMA-BL×2"],
    [9, "Cantiere Via dei Tigli", "draft", 3, "VIT-660×4 CHI-60×5 MAR-500×2"],
    [10, "Scuola Materna Arcobaleno", "draft", 2, "LED-E27×24 NAS-19×6"],
    // More drills than in stock: confirming it is refused until goods come in.
    [11, "Ristrutturazioni Moretti", "draft", 1, "TRA-18V×12 LIV-60×1"],
    [12, "Paolo Ricci (call back after 6 pm)", "draft", 0, "SCO-SA×1 SIL-TR×2"],
  ],
}

export const COLIBRI: CompanyData = {
  products: [
    ["CAN-SOY", "Soy candle, lavender", "household", "pcs", 14, 5.5, 10, 30, "20:6 9:8"],
    ["SAP-OLI", "Olive oil soap bar", "household", "pcs", 5.5, 1.9, 20, 60, "25:12 11:15 3:10"],
    ["TAZ-CER", "Ceramic mug, hand painted", "household", "pcs", 18, 7.2, 6, 14, "18:4 6:5"],
    ["VAS-TER", "Terracotta pot 14 cm", "garden", "pcs", 6.8, 2.4, 10, 25, "16:6"],
    ["SEM-BAS", "Basil seeds", "garden", "pcs", 2.5, 0.7, 15, 40, "14:10 4:12"],
    ["PEN-ACQ", "Watercolour brush set", "paint", "pcs", 16, 6.9, 4, 8, "12:3"],
  ],
  adjustments: [["TAZ-CER", 8, -1, "Broken in the shop"]],
  restocks: [["SAP-OLI", 10, 30]],
  orders: [
    [1, "Agriturismo La Collina", "shipped", 15, "SAP-OLI×10 CAN-SOY×4"],
    [2, "Erika Vitale", "confirmed", 6, "TAZ-CER×2"],
    [3, "B&B Il Glicine", "draft", 1, "CAN-SOY×6 VAS-TER×4"],
  ],
}
