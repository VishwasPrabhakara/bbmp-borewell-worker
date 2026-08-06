export const FRESHNESS_HOURS = 6;
export const RUNNING_TIMEOUT_MINUTES = 30;
export const FT_TO_M = 0.3048;
export const LPM_TO_M3_PER_SEC = 1 / 60000;
export const TRANSMISSIVITY_SCALE = 1000000;
export const MIN_MONTHLY_DRAWDOWN_M = 0.3;

export const CRITICAL_GW_MIN_WEEKS = 4;
export const CRITICAL_GW_MIN_COMPARISONS = 3;
export const CRITICAL_GW_MAX_WEEK_GAP = 2;
export const CRITICAL_GW_RELATIVE_JUMP_RATIO = 10;
export const CRITICAL_GW_MIN_LARGE_JUMP_FT = 50;
export const CRITICAL_GW_DECLINE_FT_PER_WEEK = 0.1;
export const TREND_SIGNIFICANCE_ALPHA = 0.05;
export const WARD_MIN_CLASSIFIED_SENSORS = 2;
export const WARD_DECLINING_SENSOR_FRACTION = 0.5;

export const API_CACHE_SECONDS = 60 * 60;

export const CACHEABLE_GET_PATHS = new Set([
  "/api/sensors",
  "/api/qc/sensors",
  "/api/qc/wards",
  "/api/ward-weekly-levels",
  "/api/critical-wards-groundwater",
  "/api/population/wards",
  "/api/water-level",
  "/api/specific-capacity/ward",
  "/api/pumping-performance/wards",
  "/api/pumping-performance/ward"
]);

export const PREVIOUS_CRITICAL_WARDS = [
  ["48", "Muneshwaranagar"],
  ["33", "Manorayanapalya"],
  ["13", "Mallasandra"],
  ["122", "Kempapura Agrahara"],
  ["102", "Vrishabhavathi"],
  ["161", "Hosakerehalli"],
  ["22", "Vishwanatha Nagenahalli"],
  ["195", "Konanakunte"],
  ["127", "Moodalapalya"],
  ["116", "Neelasandra"],
  ["15", "T. Dasarahalli"],
  ["183", "Chikkalasandra"],
  ["74", "Shakthiganapathinagar"],
  ["37", "Yeshwanthpura"],
  ["68", "Mahalakshmipuram"],
  ["31", "Kushalnagar"],
  ["19", "Sanjaynagar"],
  ["187", "Puttenahalli"],
  ["43", "Nandini Layout"],
  ["28", "Kammanahalli"],
  ["123", "Vijaynagar"],
  ["134", "Bapujinagar"],
  ["14", "Bagalagunte"],
  ["130", "Ullalu"],
  ["69", "Laggere"],
  ["32", "Kavalbyrasandra"],
  ["57", "C. V. Raman Nagar"],
  ["186", "Jaraganahalli"],
  ["189", "Hongasandra"],
  ["190", "Mangammanapalya"],
  ["163", "Kathriguppe"],
  ["39", "Chokkasandra"],
  ["185", "Yelachenahalli"],
  ["124", "Hosahalli"],
  ["10", "Doddabommasandra"],
  ["156", "Srinagar"],
  ["103", "Kaveripura"],
  ["71", "Hegganahalli"],
  ["148", "Ejipura"],
  ["128", "Nagarabhavi"],
  ["81", "Vignananagar"],
  ["21", "Hebbala"],
  ["6", "Thanisandra"],
  ["75", "Shankara Matha"],
  ["49", "Lingarajapuram"],
  ["171", "Gurappanapalya"],
  ["30", "Kadugondanahalli"],
  ["70", "Rajagopalanagar"],
  ["126", "Maruthi Mandira"],
  ["36", "Mathikere"],
  ["8", "Kodigehalli"],
  ["133", "Hampinagar"],
  ["131", "Nayandahalli"],
  ["97", "Dayanandanagar"],
  ["121", "Binnipete"],
  ["101", "Kamakshipalya"],
  ["164", "Vidyapeetha"],
  ["18", "Radhakrishna Temple"],
  ["144", "Siddapura"],
  ["40", "Dodda Bidarkallu"]
];
