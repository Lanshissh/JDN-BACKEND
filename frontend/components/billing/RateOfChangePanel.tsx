import React, { memo, useMemo, useRef, useState, useEffect } from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ScrollView,
  Modal,
  useWindowDimensions,
} from "react-native";
import axios, { AxiosInstance } from "axios";
import { Ionicons } from "@expo/vector-icons";
import { Picker } from "@react-native-picker/picker";
import { useAuth } from "../../contexts/AuthContext";
import { BASE_API } from "../../constants/api";

const isWeb = Platform.OS === "web";
const today = () => new Date().toISOString().slice(0, 10);
const isYMD = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const fmt = (v: any, d = 2) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return Intl.NumberFormat(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(n);
};

const toText = (v: any) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

const notify = (title: string, message?: any) => {
  const m = toText(message);
  if (isWeb && typeof window !== "undefined" && window.alert) {
    window.alert(m ? `${title}\n\n${m}` : title);
  } else {
    try {
      Alert.alert(title, m || undefined);
    } catch {
      console.warn(`${title}: ${m}`);
    }
  }
};

const handleError = (
  setErr: (s: string) => void,
  fallbackMsg: string,
  e: any
) => {
  const status = e?.response?.status;
  const url = e?.config?.url;
  const method = e?.config?.method;
  const data = e?.response?.data;
  const core =
    e?.response?.data?.error ??
    e?.response?.data?.message ??
    e?.message ??
    fallbackMsg;
  const detail = [
    status ? `HTTP ${status}` : null,
    method && url ? `${String(method).toUpperCase()} ${url}` : url,
    data ? `\nResponse:\n${toText(data)}` : null,
  ]
    .filter(Boolean)
    .join(" — ");
  const text = [toText(core), detail].filter(Boolean).join("\n");
  setErr(text);
  notify("Request failed", text);
};

type RocMeter = {
  meter_id?: string;
  meter_sn?: string;
  meter_type?: string;
  stall_id?: string | null;
  tenant_id?: string | null;
  building_id?: string | null;
  current_period?: { start?: string; end?: string };
  previous_period?: { start?: string; end?: string; month?: string | null };
  current_consumption?: number | null;
  previous_consumption?: number | null;
  rate_of_change?: number | null;
  error?: string;
  [key: string]: any;
};

type RocTenantGroup = {
  meter_type?: string;
  meters?: RocMeter[];
  totals?: {
    current_consumption?: number | null;
    previous_consumption?: number | null;
    rate_of_change?: number | null;
  };
};

type RocTenant = {
  tenant_id?: string;
  period?: {
    current?: { start?: string; end?: string };
    previous?: { start?: string; end?: string; month?: string | null };
    anchor?: { start?: string; end?: string; month?: string | null };
  };
  groups?: RocTenantGroup[];
};

type RocBuildingTenantRow = {
  tenant_id?: string | null;
  tenant_sn?: string | null;
  tenant_name?: string | null;
  meters?: RocMeter[];
  totals?: {
    current_consumption?: number | null;
    previous_consumption?: number | null;
    rate_of_change?: number | null;
  };
};

type RocBuilding = {
  building_id?: string;
  building_name?: string | null;
  period?: {
    current?: { start?: string; end?: string };
    previous?: { start?: string; end?: string };
  };
  tenants?: RocBuildingTenantRow[];
};

type BuildingMonthlyTotals = {
  building_id?: string;
  building_name?: string | null;
  period?: { start?: string; end?: string };
  totals?: { electric?: number; water?: number; lpg?: number };
};

type BuildingFourMonths = {
  building_id?: string;
  building_name?: string | null;
  window?: { start?: string; end?: string };
  months?: Array<{
    label?: string;
    start?: string;
    end?: string;
    previous?: { month?: string; start?: string; end?: string };
    totals?: { electric?: number; water?: number; lpg?: number };
  }>;
  totals_all?: {
    electric?: number;
    water?: number;
    lpg?: number;
    all_utilities?: number;
  };
};

type BuildingYearly = {
  building_id?: string;
  building_name?: string | null;
  year?: number;
  months?: Array<{
    label?: string;
    start?: string;
    end?: string;
    previous?: { month?: string; start?: string; end?: string };
    totals?: { electric?: number; water?: number; lpg?: number };
  }>;
  totals_all?: {
    electric?: number;
    water?: number;
    lpg?: number;
    all_utilities?: number;
  };
};

type BuildingOption = {
  building_id?: string;
  building_name?: string | null;
};

type BusyKey =
  | null
  | "meter"
  | "tenant"
  | "building"
  | "monthly"
  | "quarterly"
  | "yearly";

type Mode = "meter" | "tenant" | "building" | "comparison";

function CalendarDatePicker({
  label,
  value,
  onChangeText,
  placeholder,
  icon = "calendar",
  isMobile,
}: {
  label: string;
  value: string;
  onChangeText: (date: string) => void;
  placeholder?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  isMobile?: boolean;
}) {
  const [showCalendar, setShowCalendar] = useState(false);
  const [viewDate, setViewDate] = useState(() => {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(value + "T12:00:00");
    }
    return new Date();
  });

  const formatDisplayDate = (dateStr: string) => {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
      return placeholder || "Select date";
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();

    const days: Array<{
      date: number | null;
      isCurrentMonth: boolean;
      fullDate: Date | null;
    }> = [];

    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startingDayOfWeek - 1; i >= 0; i--) {
      days.push({
        date: prevMonthLastDay - i,
        isCurrentMonth: false,
        fullDate: new Date(year, month - 1, prevMonthLastDay - i),
      });
    }

    for (let i = 1; i <= daysInMonth; i++) {
      days.push({
        date: i,
        isCurrentMonth: true,
        fullDate: new Date(year, month, i),
      });
    }

    const remainingDays = 42 - days.length;
    for (let i = 1; i <= remainingDays; i++) {
      days.push({
        date: i,
        isCurrentMonth: false,
        fullDate: new Date(year, month + 1, i),
      });
    }

    return days;
  };

  const handleDateSelect = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    onChangeText(`${year}-${month}-${day}`);
    setShowCalendar(false);
  };

  const handlePrevMonth = () => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  };

  const handleToday = () => {
    const t = new Date();
    setViewDate(t);
    handleDateSelect(t);
  };

  const isSelectedDate = (date: Date | null) => {
    if (!date || !value) return false;
    const selectedDate = new Date(value + "T12:00:00");
    return (
      date.getDate() === selectedDate.getDate() &&
      date.getMonth() === selectedDate.getMonth() &&
      date.getFullYear() === selectedDate.getFullYear()
    );
  };

  const isToday = (date: Date | null) => {
    if (!date) return false;
    const t = new Date();
    return (
      date.getDate() === t.getDate() &&
      date.getMonth() === t.getMonth() &&
      date.getFullYear() === t.getFullYear()
    );
  };

  const days = getDaysInMonth(viewDate);

  return (
    <View style={calendarStyles.container}>
      <Text style={calendarStyles.label}>{label}</Text>
      <TouchableOpacity
        style={calendarStyles.inputContainer}
        onPress={() => setShowCalendar(true)}
      >
        <Ionicons
          name={icon}
          size={16}
          color="#64748B"
          style={calendarStyles.icon}
        />
        <Text
          style={[
            calendarStyles.inputText,
            !value && calendarStyles.placeholder,
          ]}
        >
          {formatDisplayDate(value)}
        </Text>
        <Ionicons name="chevron-down" size={16} color="#64748B" />
      </TouchableOpacity>

      <Modal
        visible={showCalendar}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCalendar(false)}
      >
        <TouchableOpacity
          style={calendarStyles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowCalendar(false)}
        >
          <TouchableOpacity
            style={[
              calendarStyles.calendarContainer,
              isMobile && calendarStyles.calendarContainerMobile,
            ]}
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={calendarStyles.calendarHeader}>
              <Text style={calendarStyles.monthYear}>
                {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
              </Text>
              <View style={calendarStyles.headerButtons}>
                <TouchableOpacity
                  style={calendarStyles.navButton}
                  onPress={handlePrevMonth}
                >
                  <Ionicons name="chevron-back" size={20} color="#374151" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={calendarStyles.navButton}
                  onPress={handleNextMonth}
                >
                  <Ionicons name="chevron-forward" size={20} color="#374151" />
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              style={calendarStyles.todayButton}
              onPress={handleToday}
            >
              <Ionicons name="today" size={14} color="#2563EB" />
              <Text style={calendarStyles.todayText}>Today</Text>
            </TouchableOpacity>

            <View style={calendarStyles.dayHeaders}>
              {DAYS.map((day) => (
                <Text key={day} style={calendarStyles.dayHeader}>
                  {day}
                </Text>
              ))}
            </View>

            <View style={calendarStyles.calendarGrid}>
              {days.map((day, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    calendarStyles.dayCell,
                    !day.isCurrentMonth && calendarStyles.dayCellInactive,
                    isSelectedDate(day.fullDate) &&
                      calendarStyles.dayCellSelected,
                    isToday(day.fullDate) &&
                      !isSelectedDate(day.fullDate) &&
                      calendarStyles.dayCellToday,
                  ]}
                  onPress={() => day.fullDate && handleDateSelect(day.fullDate)}
                  disabled={!day.fullDate}
                >
                  <Text
                    style={[
                      calendarStyles.dayText,
                      !day.isCurrentMonth && calendarStyles.dayTextInactive,
                      isSelectedDate(day.fullDate) &&
                        calendarStyles.dayTextSelected,
                      isToday(day.fullDate) &&
                        !isSelectedDate(day.fullDate) &&
                        calendarStyles.dayTextToday,
                    ]}
                  >
                    {day.date}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={calendarStyles.calendarFooter}>
              <TouchableOpacity
                style={calendarStyles.cancelButton}
                onPress={() => setShowCalendar(false)}
              >
                <Text style={calendarStyles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function RateOfChangePanel() {
  const { token } = useAuth();
  const { width } = useWindowDimensions();
  const isMobile = width < 640;

  const headerToken =
    token && /^Bearer\s/i.test(token.trim())
      ? token.trim()
      : token
      ? `Bearer ${token.trim()}`
      : "";

  const api: AxiosInstance = useMemo(
    () =>
      axios.create({
        baseURL: BASE_API ?? "",
        timeout: 20000,
        headers: headerToken ? { Authorization: headerToken } : {},
      }),
    [headerToken]
  );

  const detectedPrefixRef = useRef<string | null>(null);
  const candidates = useRef<string[]>(["", "/api", "/v1", "/api/v1"]).current;

  const [mode, setMode] = useState<Mode>("meter");
  const [buildingId, setBuildingId] = useState("");
  const [meterId, setMeterId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [startDate, setStartDate] = useState<string>(() => {
    const d = new Date();
    const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
    const m = d.getMonth() === 0 ? 11 : d.getMonth() - 1;
    return `${y}-${String(m + 1).padStart(2, "0")}-21`;
  });
  const [endDate, setEndDate] = useState<string>(today());
  const [year, setYear] = useState<string>(String(new Date().getFullYear()));

  const [busy, setBusy] = useState<BusyKey>(null);
  const [errText, setErrText] = useState("");

  const [meterRoc, setMeterRoc] = useState<RocMeter | null>(null);
  const [tenantRoc, setTenantRoc] = useState<RocTenant | null>(null);
  const [buildingRoc, setBuildingRoc] = useState<RocBuilding | null>(null);
  const [cmpMonthly, setCmpMonthly] =
    useState<BuildingMonthlyTotals | null>(null);
  const [cmpFour, setCmpFour] = useState<BuildingFourMonths | null>(null);
  const [cmpYearly, setCmpYearly] = useState<BuildingYearly | null>(null);

  const [buildings, setBuildings] = useState<BuildingOption[]>([]);

  useEffect(() => {
    if (!token) return;
    const loadBuildings = async () => {
      try {
        const res = await api.get<BuildingOption[]>("/buildings");
        const list = Array.isArray(res.data) ? res.data : [];
        setBuildings(list);
      } catch (e) {
        console.error("Fetch buildings for ROC failed:", e);
      }
    };
    loadBuildings();
  }, [api, token]);

  async function getWithAutoPrefix<T>(rawPath: string) {
    const tried: Array<{ prefix: string; status: number | "netfail" }> = [];

    if (detectedPrefixRef.current != null) {
      const pref = detectedPrefixRef.current!;
      const path = `${pref}${rawPath}`;
      try {
        const res = await api.get<T>(path);
        return res.data;
      } catch (e: any) {
        const st = e?.response?.status;
        if (st === 404) detectedPrefixRef.current = null;
        else throw e;
      }
    }

    for (const pref of candidates) {
      const path = `${pref}${rawPath}`;
      try {
        const res = await api.get<T>(path);
        detectedPrefixRef.current = pref;
        return res.data;
      } catch (e: any) {
        const st = e?.response?.status;
        tried.push({ prefix: pref, status: st ?? "netfail" });
        if (st && st !== 404) {
          detectedPrefixRef.current = pref;
          throw e;
        }
      }
    }

    const matrix = tried
      .map((t) => `${t.prefix || "(root)"} → ${String(t.status)}`)
      .join("\n");
    throw new Error(`All route prefixes returned 404.\nTried:\n${matrix}`);
  }

  const runMeterRoc = async () => {
    if (!meterId.trim()) return notify("Missing Meter ID");
    if (!isYMD(startDate) || !isYMD(endDate))
      return notify("Invalid dates", "Use YYYY-MM-DD.");

    setBusy("meter");
    setErrText("");
    setMeterRoc(null);

    try {
      const raw = `/roc/meters/${encodeURIComponent(
        meterId.trim()
      )}/period-start/${encodeURIComponent(
        startDate
      )}/period-end/${encodeURIComponent(endDate)}`;
      const data = await getWithAutoPrefix<RocMeter>(raw);
      setMeterRoc(data || null);
    } catch (e: any) {
      handleError(setErrText, "Meter rate-of-change failed", e);
    } finally {
      setBusy(null);
    }
  };

  const runTenantRoc = async () => {
    if (!tenantId.trim()) return notify("Missing Tenant ID");
    if (!isYMD(startDate) || !isYMD(endDate))
      return notify("Invalid dates", "Use YYYY-MM-DD.");

    setBusy("tenant");
    setErrText("");
    setTenantRoc(null);

    try {
      const raw = `/roc/tenants/${encodeURIComponent(
        tenantId.trim()
      )}/period-start/${encodeURIComponent(
        startDate
      )}/period-end/${encodeURIComponent(endDate)}`;
      const data = await getWithAutoPrefix<RocTenant>(raw);
      setTenantRoc(data || null);
    } catch (e: any) {
      handleError(setErrText, "Tenant rate-of-change failed", e);
    } finally {
      setBusy(null);
    }
  };

  const runBuildingRoc = async () => {
    if (!buildingId.trim()) return notify("Missing Building ID");
    if (!isYMD(startDate) || !isYMD(endDate))
      return notify("Invalid dates", "Use YYYY-MM-DD.");

    setBusy("building");
    setErrText("");
    setBuildingRoc(null);

    try {
      const raw = `/roc/buildings/${encodeURIComponent(
        buildingId.trim()
      )}/period-start/${encodeURIComponent(
        startDate
      )}/period-end/${encodeURIComponent(endDate)}`;
      const data = await getWithAutoPrefix<RocBuilding>(raw);
      setBuildingRoc(data || null);
    } catch (e: any) {
      handleError(setErrText, "Building rate-of-change failed", e);
    } finally {
      setBusy(null);
    }
  };

  const runMonthly = async () => {
    if (!buildingId.trim()) return notify("Missing Building ID");
    if (!isYMD(startDate) || !isYMD(endDate))
      return notify("Invalid dates", "Use YYYY-MM-DD.");

    setBusy("monthly");
    setErrText("");
    setCmpMonthly(null);

    try {
      const raw = `/roc/buildings/${encodeURIComponent(
        buildingId.trim()
      )}/period-start/${encodeURIComponent(
        startDate
      )}/period-end/${encodeURIComponent(endDate)}/monthly-comparison`;
      const data = await getWithAutoPrefix<BuildingMonthlyTotals>(raw);
      setCmpMonthly(data || null);
    } catch (e: any) {
      handleError(setErrText, "Monthly comparison failed", e);
    } finally {
      setBusy(null);
    }
  };

  const runQuarterly = async () => {
    if (!buildingId.trim()) return notify("Missing Building ID");
    if (!isYMD(startDate) || !isYMD(endDate))
      return notify("Invalid dates", "Use YYYY-MM-DD.");

    setBusy("quarterly");
    setErrText("");
    setCmpFour(null);

    try {
      const raw = `/roc/buildings/${encodeURIComponent(
        buildingId.trim()
      )}/period-start/${encodeURIComponent(
        startDate
      )}/period-end/${encodeURIComponent(endDate)}/quarterly-comparison`;
      const data = await getWithAutoPrefix<BuildingFourMonths>(raw);
      setCmpFour(data || null);
    } catch (e: any) {
      handleError(setErrText, "4-Month comparison failed", e);
    } finally {
      setBusy(null);
    }
  };

  const runYearly = async () => {
    if (!buildingId.trim()) return notify("Missing Building ID");
    const yr = parseInt(year, 10);
    if (isNaN(yr) || yr < 1900) return notify("Invalid year", "Enter YYYY.");

    setBusy("yearly");
    setErrText("");
    setCmpYearly(null);

    try {
      const raw = `/roc/buildings/${encodeURIComponent(
        buildingId.trim()
      )}/year/${encodeURIComponent(String(yr))}/yearly-comparison`;
      const data = await getWithAutoPrefix<BuildingYearly>(raw);
      setCmpYearly(data || null);
    } catch (e: any) {
      handleError(setErrText, "Yearly comparison failed", e);
    } finally {
      setBusy(null);
    }
  };

  const dl = (
    filename: string,
    content: string,
    mime = "text/csv;charset=utf-8"
  ) => {
    if (!(isWeb && typeof window !== "undefined")) {
      notify("CSV created", "Use your device's share/download feature.");
      return;
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  };

  const exportMonthlyCsv = () => {
    if (!cmpMonthly)
      return notify("Nothing to export", "Run Monthly comparison first.");
    const bid = cmpMonthly.building_id ?? "";
    const ps = cmpMonthly.period?.start ?? "";
    const pe = cmpMonthly.period?.end ?? "";
    const t = cmpMonthly.totals ?? {};
    const header = [
      "Building ID",
      "Period Start",
      "Period End",
      "Electric",
      "Water",
      "LPG",
    ];
    const row = [bid, ps, pe, t.electric ?? "", t.water ?? "", t.lpg ?? ""]
      .map((s) => `"${String(s ?? "").replace(/"/g, '""')}"`)
      .join(",");
    dl(
      `monthly_comparison_${bid}_${ps}_${pe}.csv`,
      `"${header.join('","')}"\n${row}\n`
    );
  };

  const exportQuarterlyCsv = () => {
    if (!cmpFour)
      return notify("Nothing to export", "Run 4-Month comparison first.");
    const bid = cmpFour.building_id ?? "";
    const win = cmpFour.window ?? {};
    const header = [
      "Month",
      "Start",
      "End",
      "Prev Month",
      "Prev Start",
      "Prev End",
      "Electric",
      "Water",
      "LPG",
    ];
    const lines = [`"${header.join('","')}"`];
    (cmpFour.months ?? []).forEach((m) => {
      const prev = m.previous ?? {};
      const tot = m.totals ?? {};
      lines.push(
        [
          m.label ?? "",
          m.start ?? "",
          m.end ?? "",
          prev.month ?? "",
          prev.start ?? "",
          prev.end ?? "",
          tot.electric ?? "",
          tot.water ?? "",
          tot.lpg ?? "",
        ]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(",")
      );
    });
    const all = cmpFour.totals_all ?? {};
    lines.push(
      `"Σ Totals","","","","","",${all.electric ?? ""},${
        all.water ?? ""
      },${all.lpg ?? ""}`
    );
    lines.push(
      `"All Utilities","","","","","",${all.all_utilities ?? ""},,`
    );
    dl(
      `quarterly_comparison_${bid}_${win.start ?? ""}_${win.end ?? ""}.csv`,
      lines.join("\n") + "\n"
    );
  };

  const exportYearlyCsv = () => {
    if (!cmpYearly)
      return notify("Nothing to export", "Run Yearly comparison first.");
    const bid = cmpYearly.building_id ?? "";
    const header = [
      "Month",
      "Start",
      "End",
      "Prev Month",
      "Prev Start",
      "Prev End",
      "Electric",
      "Water",
      "LPG",
    ];
    const lines = [`"${header.join('","')}"`];
    (cmpYearly.months ?? []).forEach((m) => {
      const prev = m.previous ?? {};
      const tot = m.totals ?? {};
      lines.push(
        [
          m.label ?? "",
          m.start ?? "",
          m.end ?? "",
          prev.month ?? "",
          prev.start ?? "",
          prev.end ?? "",
          tot.electric ?? "",
          tot.water ?? "",
          tot.lpg ?? "",
        ]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(",")
      );
    });
    const all = cmpYearly.totals_all ?? {};
    lines.push(
      `"Σ Annual Totals","","","","","",${all.electric ?? ""},${
        all.water ?? ""
      },${all.lpg ?? ""}`
    );
    lines.push(
      `"All Utilities","","","","","",${all.all_utilities ?? ""},,`
    );
    dl(
      `yearly_comparison_${bid}_${cmpYearly.year ?? ""}.csv`,
      lines.join("\n") + "\n"
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.contentContainer,
        isMobile && styles.contentContainerMobile,
      ]}
    >
      <View style={[styles.header, isMobile && styles.headerMobile]}>
        <Text style={[styles.title, isMobile && styles.titleMobile]}>
          Rate of Change Analysis
        </Text>
        <Text style={[styles.subtitle, isMobile && styles.subtitleMobile]}>
          Analyze consumption patterns and trends across meters, tenants, and
          buildings
        </Text>
      </View>

      <View
        style={[styles.tabContainer, isMobile && styles.tabContainerMobile]}
      >
        <TabButton
          icon="speedometer"
          label="Meter"
          active={mode === "meter"}
          onPress={() => setMode("meter")}
        />
        <TabButton
          icon="person"
          label="Tenant"
          active={mode === "tenant"}
          onPress={() => setMode("tenant")}
        />
        <TabButton
          icon="business"
          label="Building"
          active={mode === "building"}
          onPress={() => setMode("building")}
        />
        <TabButton
          icon="analytics"
          label="Comparison"
          active={mode === "comparison"}
          onPress={() => setMode("comparison")}
        />
      </View>

      {!!errText && (
        <View style={styles.errorCard}>
          <Ionicons name="warning" size={20} color="#DC2626" />
          <View style={styles.errorContent}>
            <Text style={styles.errorTitle}>Request Failed</Text>
            <Text style={styles.errorText}>{errText}</Text>
          </View>
        </View>
      )}

      <View style={[styles.inputCard, isMobile && styles.inputCardMobile]}>
        <Text style={styles.sectionTitle}>Parameters</Text>

        <View style={styles.inputGrid}>
          {mode === "meter" && (
            <InputField
              label="Meter ID"
              value={meterId}
              onChangeText={setMeterId}
              placeholder="MTR-001"
              icon="hardware-chip"
            />
          )}

          {mode === "tenant" && (
            <InputField
              label="Tenant ID"
              value={tenantId}
              onChangeText={setTenantId}
              placeholder="TNT-001"
              icon="person"
            />
          )}

          {(mode === "building" || mode === "comparison") && (
            <View style={styles.inputField}>
              <Text style={styles.inputLabel}>Building</Text>
              <View style={styles.inputContainer}>
                <Ionicons
                  name="business"
                  size={16}
                  color="#64748B"
                  style={styles.inputIcon}
                />
                {buildings.length > 0 ? (
                  <Picker
                    selectedValue={buildingId}
                    onValueChange={(value) => setBuildingId(String(value))}
                    style={styles.picker}
                    mode={Platform.OS === "android" ? "dropdown" : undefined}
                  >
                    <Picker.Item label="Select building…" value="" />
                    {buildings.map((b) => (
                      <Picker.Item
                        key={b.building_id}
                        label={
                          b.building_name
                            ? `${b.building_name} (${b.building_id})`
                            : b.building_id ?? ""
                        }
                        value={b.building_id}
                      />
                    ))}
                  </Picker>
                ) : (
                  <TextInput
                    style={styles.textInput}
                    value={buildingId}
                    onChangeText={setBuildingId}
                    placeholder="BLDG-001"
                    placeholderTextColor="#94A3B8"
                    autoCapitalize="characters"
                  />
                )}
              </View>
            </View>
          )}

          <CalendarDatePicker
            label="Start Date"
            value={startDate}
            onChangeText={setStartDate}
            placeholder="YYYY-MM-DD"
            icon="calendar"
            isMobile={isMobile}
          />

          <CalendarDatePicker
            label="End Date"
            value={endDate}
            onChangeText={setEndDate}
            placeholder="YYYY-MM-DD"
            icon="calendar"
            isMobile={isMobile}
          />

          {mode === "comparison" && (
            <InputField
              label="Year"
              value={year}
              onChangeText={(v) =>
                setYear(v.replace(/[^\d]/g, "").slice(0, 4))
              }
              placeholder="2024"
              icon="today"
              keyboardType="numeric"
            />
          )}
        </View>

        <View style={styles.actionRow}>
          {mode === "meter" && (
            <ActionButton
              label="Generate ROC"
              icon="play"
              onPress={runMeterRoc}
              loading={busy === "meter"}
              variant="primary"
            />
          )}
          {mode === "tenant" && (
            <ActionButton
              label="Generate ROC"
              icon="play"
              onPress={runTenantRoc}
              loading={busy === "tenant"}
              variant="primary"
            />
          )}
          {mode === "building" && (
            <ActionButton
              label="Generate ROC"
              icon="play"
              onPress={runBuildingRoc}
              loading={busy === "building"}
              variant="primary"
            />
          )}
          {mode === "comparison" && (
            <View
              style={[
                styles.comparisonActions,
                isMobile && styles.comparisonActionsMobile,
              ]}
            >
              <ActionButton
                label="Monthly"
                icon="calendar"
                onPress={runMonthly}
                loading={busy === "monthly"}
                variant="secondary"
              />
              <ActionButton
                label="4-Month"
                icon="git-branch"
                onPress={runQuarterly}
                loading={busy === "quarterly"}
                variant="secondary"
              />
              <ActionButton
                label="Yearly"
                icon="albums"
                onPress={runYearly}
                loading={busy === "yearly"}
                variant="secondary"
              />
            </View>
          )}
        </View>
      </View>

      <View
        style={[
          styles.resultsSection,
          isMobile && styles.resultsSectionMobile,
        ]}
      >
        {mode === "meter" && meterRoc && (
          <ResultsCard title="Meter Analysis" icon="speedometer">
            <View style={styles.meterHeader}>
              <Text style={styles.meterId}>
                {meterRoc.meter_sn || meterRoc.meter_id}
              </Text>
              <Text style={styles.meterType}>{meterRoc.meter_type}</Text>
            </View>

            <View
              style={[styles.statsGrid, isMobile && styles.statsGridMobile]}
            >
              <StatCard
                label="Current Period"
                value={fmt(meterRoc.current_consumption, 2)}
                unit="kWh"
                trend="current"
              />
              <StatCard
                label="Previous Period"
                value={fmt(meterRoc.previous_consumption, 2)}
                unit="kWh"
                trend="previous"
              />
              <StatCard
                label="Rate of Change"
                value={fmt(meterRoc.rate_of_change, 2)}
                unit="%"
                trend={
                  meterRoc.rate_of_change && meterRoc.rate_of_change > 0
                    ? "up"
                    : "down"
                }
              />
            </View>
          </ResultsCard>
        )}

        {mode === "tenant" && tenantRoc && (
          <ResultsCard title="Tenant Analysis" icon="person">
            <Text style={styles.tenantId}>Tenant: {tenantRoc.tenant_id}</Text>

            {(tenantRoc.groups ?? []).map((group, index) => (
              <View key={index} style={styles.utilitySection}>
                <Text style={styles.utilityTitle}>
                  {group.meter_type} Consumption
                </Text>
                {group.totals && (
                  <View
                    style={[
                      styles.statsGrid,
                      isMobile && styles.statsGridMobile,
                    ]}
                  >
                    <StatCard
                      label="Current"
                      value={fmt(group.totals.current_consumption, 2)}
                      unit="kWh"
                    />
                    <StatCard
                      label="Previous"
                      value={fmt(group.totals.previous_consumption, 2)}
                      unit="kWh"
                    />
                    <StatCard
                      label="ROC"
                      value={fmt(group.totals.rate_of_change, 2)}
                      unit="%"
                    />
                  </View>
                )}
              </View>
            ))}
          </ResultsCard>
        )}

        {mode === "building" && buildingRoc && (
          <ResultsCard title="Building Analysis" icon="business">
            <View style={styles.buildingHeader}>
              <Text style={styles.buildingName}>
                {buildingRoc.building_name}
              </Text>
              <Text style={styles.buildingId}>{buildingRoc.building_id}</Text>
            </View>

            {(buildingRoc.tenants ?? []).map((tenant, index) => (
              <View key={index} style={styles.tenantCard}>
                <Text style={styles.tenantName}>
                  {tenant.tenant_name || tenant.tenant_id}
                </Text>
                {tenant.totals && (
                  <View
                    style={[
                      styles.statsGrid,
                      isMobile && styles.statsGridMobile,
                    ]}
                  >
                    <StatCard
                      label="Current"
                      value={fmt(tenant.totals.current_consumption, 2)}
                      unit="kWh"
                      compact
                    />
                    <StatCard
                      label="Previous"
                      value={fmt(tenant.totals.previous_consumption, 2)}
                      unit="kWh"
                      compact
                    />
                    <StatCard
                      label="ROC"
                      value={fmt(tenant.totals.rate_of_change, 2)}
                      unit="%"
                      compact
                    />
                  </View>
                )}
              </View>
            ))}
          </ResultsCard>
        )}

        {mode === "comparison" && (
          <>
            {cmpMonthly && (
              <ResultsCard title="Monthly Comparison" icon="calendar">
                <View style={styles.comparisonHeader}>
                  <Text style={styles.period}>
                    {cmpMonthly.period?.start} → {cmpMonthly.period?.end}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statsGrid,
                    isMobile && styles.statsGridMobile,
                  ]}
                >
                  <StatCard
                    label="Electric"
                    value={fmt(cmpMonthly.totals?.electric)}
                    unit="kWh"
                    variant="electric"
                  />
                  <StatCard
                    label="Water"
                    value={fmt(cmpMonthly.totals?.water)}
                    unit="m³"
                    variant="water"
                  />
                  <StatCard
                    label="LPG"
                    value={fmt(cmpMonthly.totals?.lpg)}
                    unit="kg"
                    variant="lpg"
                  />
                </View>
                <View style={styles.exportRow}>
                  <ActionButton
                    label="Export CSV"
                    icon="download"
                    onPress={exportMonthlyCsv}
                    variant="outline"
                  />
                </View>
              </ResultsCard>
            )}

            {cmpFour && (
              <ResultsCard title="4-Month Comparison" icon="git-branch">
                <DataTable
                  headers={["Month", "Electric", "Water", "LPG"]}
                  data={
                    cmpFour.months?.map((month) => ({
                      month: month.label,
                      electric: fmt(month.totals?.electric),
                      water: fmt(month.totals?.water),
                      lpg: fmt(month.totals?.lpg),
                    })) || []
                  }
                />
                <View style={styles.totalsSection}>
                  <Text style={styles.totalsTitle}>Total Consumption</Text>
                  <View
                    style={[
                      styles.statsGrid,
                      isMobile && styles.statsGridMobile,
                    ]}
                  >
                    <StatCard
                      label="Electric"
                      value={fmt(cmpFour.totals_all?.electric)}
                      unit="kWh"
                      compact
                    />
                    <StatCard
                      label="Water"
                      value={fmt(cmpFour.totals_all?.water)}
                      unit="m³"
                      compact
                    />
                    <StatCard
                      label="LPG"
                      value={fmt(cmpFour.totals_all?.lpg)}
                      unit="kg"
                      compact
                    />
                  </View>
                </View>
                <View style={styles.exportRow}>
                  <ActionButton
                    label="Export CSV"
                    icon="download"
                    onPress={exportQuarterlyCsv}
                    variant="outline"
                  />
                </View>
              </ResultsCard>
            )}

            {cmpYearly && (
              <ResultsCard title="Yearly Comparison" icon="albums">
                <Text style={styles.yearTitle}>{cmpYearly.year}</Text>
                <DataTable
                  headers={["Month", "Electric", "Water", "LPG"]}
                  data={
                    cmpYearly.months?.map((month) => ({
                      month: month.label,
                      electric: fmt(month.totals?.electric),
                      water: fmt(month.totals?.water),
                      lpg: fmt(month.totals?.lpg),
                    })) || []
                  }
                />
                <View style={styles.totalsSection}>
                  <Text style={styles.totalsTitle}>Annual Totals</Text>
                  <View
                    style={[
                      styles.statsGrid,
                      isMobile && styles.statsGridMobile,
                    ]}
                  >
                    <StatCard
                      label="Electric"
                      value={fmt(cmpYearly.totals_all?.electric)}
                      unit="kWh"
                      compact
                    />
                    <StatCard
                      label="Water"
                      value={fmt(cmpYearly.totals_all?.water)}
                      unit="m³"
                      compact
                    />
                    <StatCard
                      label="LPG"
                      value={fmt(cmpYearly.totals_all?.lpg)}
                      unit="kg"
                      compact
                    />
                  </View>
                </View>
                <View style={styles.exportRow}>
                  <ActionButton
                    label="Export CSV"
                    icon="download"
                    onPress={exportYearlyCsv}
                    variant="outline"
                  />
                </View>
              </ResultsCard>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

function TabButton({
  icon,
  label,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.tabButton, active && styles.tabButtonActive]}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={16}
        color={active ? "#2563EB" : "#64748B"}
      />
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function InputField({
  label,
  value,
  onChangeText,
  placeholder,
  icon,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  keyboardType?: "default" | "numeric";
}) {
  return (
    <View style={styles.inputField}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={styles.inputContainer}>
        {icon && (
          <Ionicons
            name={icon}
            size={16}
            color="#64748B"
            style={styles.inputIcon}
          />
        )}
        <TextInput
          style={styles.textInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="#94A3B8"
          keyboardType={keyboardType}
        />
      </View>
    </View>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
  loading,
  variant = "primary",
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  loading?: boolean;
  variant?: "primary" | "secondary" | "outline";
}) {
  return (
    <TouchableOpacity
      style={[
        styles.actionButton,
        variant === "primary" && styles.actionButtonPrimary,
        variant === "secondary" && styles.actionButtonSecondary,
        variant === "outline" && styles.actionButtonOutline,
        loading && styles.actionButtonLoading,
      ]}
      onPress={onPress}
      disabled={loading}
    >
      <Ionicons
        name={loading ? "refresh" : icon}
        size={16}
        color={
          variant === "primary"
            ? "#FFFFFF"
            : variant === "outline"
            ? "#2563EB"
            : "#2563EB"
        }
      />
      <Text
        style={[
          styles.actionButtonText,
          variant === "primary" && styles.actionButtonTextPrimary,
          variant === "secondary" && styles.actionButtonTextSecondary,
          variant === "outline" && styles.actionButtonTextOutline,
        ]}
      >
        {loading ? "Processing..." : label}
      </Text>
    </TouchableOpacity>
  );
}

function ResultsCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.resultsCard}>
      <View style={styles.cardHeader}>
        <Ionicons name={icon} size={20} color="#2563EB" />
        <Text style={styles.cardTitle}>{title}</Text>
      </View>
      <View style={styles.cardContent}>{children}</View>
    </View>
  );
}

function StatCard({
  label,
  value,
  unit,
  trend,
  variant,
  compact,
}: {
  label: string;
  value: string;
  unit: string;
  trend?: "up" | "down" | "current" | "previous";
  variant?: "electric" | "water" | "lpg";
  compact?: boolean;
}) {
  const getTrendIcon = () => {
    if (trend === "up") return "trending-up";
    if (trend === "down") return "trending-down";
    return undefined;
  };

  const getVariantColor = () => {
    switch (variant) {
      case "electric":
        return "#F59E0B";
      case "water":
        return "#3B82F6";
      case "lpg":
        return "#EF4444";
      default:
        return "#374151";
    }
  };

  return (
    <View style={[styles.statCard, compact && styles.statCardCompact]}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.statValueRow}>
        <Text style={[styles.statValue, { color: getVariantColor() }]}>
          {value}
        </Text>
        {trend && getTrendIcon() && (
          <Ionicons
            name={getTrendIcon()}
            size={14}
            color={trend === "up" ? "#EF4444" : "#10B981"}
          />
        )}
      </View>
      <Text style={styles.statUnit}>{unit}</Text>
    </View>
  );
}

function DataTable({
  headers,
  data,
}: {
  headers: string[];
  data: Array<Record<string, string | undefined>>;
}) {
  return (
    <View style={styles.dataTable}>
      <View style={styles.tableHeader}>
        {headers.map((header, index) => (
          <Text key={index} style={styles.tableHeaderText}>
            {header}
          </Text>
        ))}
      </View>
      {data.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.tableRow}>
          {headers.map((header, cellIndex) => (
            <Text key={cellIndex} style={styles.tableCell}>
              {row[header.toLowerCase()] || "—"}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const calendarStyles = StyleSheet.create({
  container: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: "#374151",
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 8,
    backgroundColor: "#F9FAFB",
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  icon: {
    marginRight: 8,
  },
  inputText: {
    flex: 1,
    fontSize: 14,
    color: "#111827",
  },
  placeholder: {
    color: "#94A3B8",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  calendarContainer: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 20,
    width: 340,
    maxWidth: "90%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 8,
  },
  calendarContainerMobile: {
    width: "95%",
    maxWidth: 360,
    paddingHorizontal: 16,
  },
  calendarHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  monthYear: {
    fontSize: 18,
    fontWeight: "600",
    color: "#0F172A",
  },
  headerButtons: {
    flexDirection: "row",
    gap: 4,
  },
  navButton: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: "#F8FAFC",
  },
  todayButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: "#EFF6FF",
    marginBottom: 16,
    gap: 6,
  },
  todayText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#2563EB",
  },
  dayHeaders: {
    flexDirection: "row",
    marginBottom: 8,
  },
  dayHeader: {
    width: 40,
    textAlign: "center",
    fontSize: 12,
    fontWeight: "600",
    color: "#64748B",
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dayCell: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
  },
  dayCellInactive: {
    opacity: 0.4,
  },
  dayCellSelected: {
    backgroundColor: "#2563EB",
  },
  dayCellToday: {
    borderWidth: 1,
    borderColor: "#2563EB",
  },
  dayText: {
    fontSize: 14,
    color: "#374151",
  },
  dayTextInactive: {
    color: "#94A3B8",
  },
  dayTextSelected: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
  dayTextToday: {
    color: "#2563EB",
    fontWeight: "600",
  },
  calendarFooter: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#F1F5F9",
    alignItems: "flex-end",
  },
  cancelButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#64748B",
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8FAFC",
  },
  contentContainer: {
    paddingBottom: 24,
  },
  contentContainerMobile: {
    paddingBottom: 16,
  },
  header: {
    padding: 24,
    paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  headerMobile: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#0F172A",
    marginBottom: 4,
  },
  titleMobile: {
    fontSize: 22,
  },
  subtitle: {
    fontSize: 14,
    color: "#64748B",
    lineHeight: 20,
  },
  subtitleMobile: {
    fontSize: 13,
  },
  tabContainer: {
    flexDirection: "row",
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  tabContainerMobile: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexWrap: "wrap",
    gap: 8,
  },
  tabButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 8,
    backgroundColor: "#F8FAFC",
  },
  tabButtonActive: {
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#2563EB",
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#64748B",
    marginLeft: 6,
  },
  tabLabelActive: {
    color: "#2563EB",
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    margin: 24,
    marginBottom: 0,
    padding: 16,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 12,
  },
  errorContent: {
    flex: 1,
    marginLeft: 12,
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#DC2626",
    marginBottom: 4,
  },
  errorText: {
    fontSize: 12,
    color: "#7F1D1D",
    lineHeight: 16,
  },
  inputCard: {
    margin: 24,
    marginBottom: 16,
    padding: 20,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  inputCardMobile: {
    marginHorizontal: 12,
    marginTop: 16,
    marginBottom: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#0F172A",
    marginBottom: 16,
  },
  inputGrid: {
    gap: 16,
  },
  inputField: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: "500",
    color: "#374151",
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 8,
    backgroundColor: "#F9FAFB",
  },
  inputIcon: {
    padding: 12,
  },
  textInput: {
    flex: 1,
    padding: 12,
    fontSize: 14,
    color: "#111827",
  },
  picker: {
    flex: 1,
    height: 40,
    color: "#111827",
  },
  actionRow: {
    marginTop: 20,
  },
  comparisonActions: {
    flexDirection: "row",
    gap: 12,
  },
  comparisonActionsMobile: {
    flexDirection: "column",
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  actionButtonPrimary: {
    backgroundColor: "#2563EB",
  },
  actionButtonSecondary: {
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#2563EB",
  },
  actionButtonOutline: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#D1D5DB",
  },
  actionButtonLoading: {
    opacity: 0.7,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: "600",
  },
  actionButtonTextPrimary: {
    color: "#FFFFFF",
  },
  actionButtonTextSecondary: {
    color: "#2563EB",
  },
  actionButtonTextOutline: {
    color: "#374151",
  },
  resultsSection: {
    padding: 24,
    paddingTop: 0,
    gap: 16,
  },
  resultsSectionMobile: {
    paddingHorizontal: 12,
    paddingTop: 0,
    paddingBottom: 24,
  },
  resultsCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0F172A",
  },
  cardContent: {
    padding: 20,
  },
  meterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  meterId: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0F172A",
  },
  meterType: {
    fontSize: 14,
    color: "#64748B",
    backgroundColor: "#F1F5F9",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statsGrid: {
    flexDirection: "row",
    gap: 12,
  },
  statsGridMobile: {
    flexDirection: "column",
  },
  statCard: {
    flex: 1,
    padding: 16,
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    alignItems: "center",
  },
  statCardCompact: {
    padding: 12,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: "500",
    color: "#64748B",
    marginBottom: 8,
  },
  statValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#374151",
  },
  statUnit: {
    fontSize: 12,
    color: "#64748B",
  },
  tenantId: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 16,
  },
  utilitySection: {
    marginBottom: 20,
  },
  utilityTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 12,
  },
  buildingHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  buildingName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0F172A",
  },
  buildingId: {
    fontSize: 14,
    color: "#64748B",
  },
  tenantCard: {
    padding: 16,
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    marginBottom: 12,
  },
  tenantName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 12,
  },
  comparisonHeader: {
    marginBottom: 16,
  },
  period: {
    fontSize: 14,
    color: "#64748B",
  },
  yearTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0F172A",
    marginBottom: 16,
    textAlign: "center",
  },
  dataTable: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 8,
    overflow: "hidden",
    marginBottom: 16,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#F8FAFC",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  tableHeaderText: {
    flex: 1,
    padding: 12,
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
    textAlign: "center",
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  tableCell: {
    flex: 1,
    padding: 12,
    fontSize: 12,
    color: "#374151",
    textAlign: "center",
  },
  totalsSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
  },
  totalsTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 12,
  },
  exportRow: {
    marginTop: 16,
    alignItems: "flex-start",
  },
});

export default memo(RateOfChangePanel);