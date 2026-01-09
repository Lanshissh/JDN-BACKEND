import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
  Modal,
} from "react-native";
import axios from "axios";
import { Ionicons } from "@expo/vector-icons";
import { Picker } from "@react-native-picker/picker";
import { useAuth } from "../../contexts/AuthContext";
import { BASE_API } from "../../constants/api";
import RateOfChangePanel from "../../components/billing/RateOfChangePanel";

type BillingRow = {
  stall_no: string | null;
  stall_sn: string | null;
  tenant_id: string | null;
  tenant_sn: string | null;
  tenant_name: string | null;
  meter_no: string | null;
  meter_id: string;
  mult: number;
  reading_previous: number;
  reading_present: number;
  consumed_kwh: number;
  prev_consumed_kwh: number | null;
  rate_of_change_pct: number | null;
  utility_rate: number | null;
  markup_rate: number | null;
  system_rate: number | null;
  vat_rate: number | null;
  vat_amount?: number | null;
  whtax_code: string | null;
  whtax_rate?: number | null;
  whtax_amount?: number | null;
  tax_code: string | null;
  for_penalty: boolean;
  total_amount: number;
  meter_type: string | null;
  wt_rate?: number | null;
  wt?: number | null;
  billing?: { wt?: number | null; vat?: number | null; base?: number | null };
  totals?: { wt?: number | null };
};

type BillingTenant = {
  tenant_id: string | null;
  tenant_sn: string | null;
  tenant_name: string | null;
  rows: BillingRow[];
};
type BillingTotals = { total_consumed_kwh: number; total_amount: number };

type BuildingBillingResponse = {
  building_billing_id?: string;
  building_id: string;
  building_name: string | null;
  period: { start: string; end: string };
  tenants: BillingTenant[];
  totals: BillingTotals;
  generated_at: string | null;
  penalty_rate_pct?: number;
  saved_header?: any;
};

type StoredBilling = {
  building_billing_id: string;
  building_id: string;
  building_name: string | null;
  period: { start: string; end: string };
  totals: { total_consumed_kwh: number; total_amount: number };
  penalty_rate_pct?: number;
  generated_at: string | null;
  payload?: any;
};

type BuildingOption = { building_id: string; building_name: string | null };

const notify = (title: string, message?: string) => {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.alert) {
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
};

const isYMD = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: any) =>
  v == null || v === "" || isNaN(Number(v)) ? null : Number(v);

const fmt = (v: number | string | null | undefined, d = 2): string => {
  if (v == null) return "—";
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n)
    ? Intl.NumberFormat(undefined, {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(Number(n))
    : String(v);
};

const formatCurrency = (v: number | null | undefined) => {
  if (v == null || isNaN(Number(v))) return "—";
  try {
    return new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency: "PHP",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(v));
  } catch {
    return `₱${Number(v).toFixed(2)}`;
  }
};

const php10For = (r: BillingRow): number | null => {
  if (r.consumed_kwh == null || r.utility_rate == null) return null;
  const base = Number(r.consumed_kwh) * Number(r.utility_rate);
  return Number.isFinite(base) ? base : null;
};

const vatFor = (r: BillingRow): number | null => {
  if (r.vat_rate == null) return null;
  const base = php10For(r);
  if (base == null) return null;
  const v = base * Number(r.vat_rate);
  return Number.isFinite(v) ? v : null;
};

const wtFor = (r: BillingRow): number | null => {
  if (r.whtax_rate == null) return null;
  const v = (vatFor(r) ?? 0) * Number(r.whtax_rate);
  return Number.isFinite(v) ? v : null;
};

const makeBillingCsv = (payload: BuildingBillingResponse) => {
  const { building_id, building_name, period, tenants, totals, generated_at } =
    payload;
  const filename = `billing-${building_id}-${period.start}-${period.end}.csv`;

  const header = [
    "Building ID",
    "Building Name",
    "Period Start",
    "Period End",
    "Generated At",
    "Total kWh",
    "Total Amount",
  ];
  const headerRow = [
    building_id,
    building_name ?? "",
    period.start,
    period.end,
    generated_at ?? "",
    String(totals.total_consumed_kwh ?? ""),
    String(totals.total_amount ?? ""),
  ];

  const colNames = [
    "Tenant Name",
    "Tenant ID/SN",
    "Stall",
    "Meter",
    "Meter Type",
    "Multiplier",
    "Prev Reading",
    "Curr Reading",
    "Consumed kWh",
    "Prev Cons kWh",
    "Rate of Change (%)",
    "Utility Rate",
    "Markup Rate",
    "System Rate",
    "VAT Rate",
    "VAT Amount",
    "WHT Code",
    "WHT Rate",
    "WHT Amount",
    "Tax Code",
    "For Penalty",
    "Total Amount",
  ];

  const lines: string[] = [];
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  lines.push(header.map(esc).join(","));
  lines.push(headerRow.map(esc).join(","));
  lines.push("");
  lines.push(colNames.map(esc).join(","));

  for (const tenant of tenants) {
    for (const row of tenant.rows) {
      const csvRow = [
        tenant.tenant_name ?? "",
        tenant.tenant_sn ?? tenant.tenant_id ?? "",
        row.stall_sn ?? row.stall_no ?? "",
        row.meter_no ?? row.meter_id,
        row.meter_type ?? "",
        row.mult,
        row.reading_previous,
        row.reading_present,
        row.consumed_kwh,
        row.prev_consumed_kwh ?? "",
        row.rate_of_change_pct ?? "",
        row.utility_rate ?? "",
        row.markup_rate ?? "",
        row.system_rate ?? "",
        row.vat_rate ?? "",
        vatFor(row) ?? "",
        row.whtax_code ?? "",
        row.whtax_rate ?? "",
        row.whtax_amount ?? "",
        row.tax_code ?? "",
        row.for_penalty ? "YES" : "NO",
        row.total_amount,
      ];
      lines.push(csvRow.map(esc).join(","));
    }
  }

  const csv = lines.join("\n");
  return { filename, csv };
};

const saveCsv = (filename: string, csv: string) => {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    notify("CSV Generated", "CSV export is currently available on web only.");
  }
};

function CalendarDatePicker({
  label,
  value,
  onChangeText,
  placeholder,
  icon,
  isMobile,
}: {
  label: string;
  value: string;
  onChangeText: (val: string) => void;
  placeholder: string;
  icon: "calendar";
  isMobile: boolean;
}) {
  const [show, setShow] = useState(false);
  const [internalDate, setInternalDate] = useState<Date | null>(() => {
    if (isYMD(value)) {
      const [y, m, d] = value.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
    return null;
  });

  const toggleModal = () => setShow(!show);

  const applyDate = () => {
    if (!internalDate) return;
    const y = internalDate.getFullYear();
    const m = String(internalDate.getMonth() + 1).padStart(2, "0");
    const d = String(internalDate.getDate()).padStart(2, "0");
    onChangeText(`${y}-${m}-${d}`);
    setShow(false);
  };

  const daysInMonth = (year: number, month: number) =>
    new Date(year, month, 0).getDate();

  const todayDate = new Date();
  const [pickerYear, setPickerYear] = useState(
    internalDate?.getFullYear() ?? todayDate.getFullYear()
  );
  const [pickerMonth, setPickerMonth] = useState(
    internalDate?.getMonth() ?? todayDate.getMonth()
  );

  useEffect(() => {
    if (isYMD(value)) {
      const [y, m, d] = value.split("-").map(Number);
      setInternalDate(new Date(y, m - 1, d));
      setPickerYear(y);
      setPickerMonth(m - 1);
    }
  }, [value]);

  const renderCalendar = () => {
    const firstDay = new Date(pickerYear, pickerMonth, 1).getDay();
    const totalDays = daysInMonth(pickerYear, pickerMonth + 1);

    const weeks: (number | null)[][] = [];
    let week: (number | null)[] = [];

    for (let i = 0; i < firstDay; i++) {
      week.push(null);
    }

    for (let day = 1; day <= totalDays; day++) {
      week.push(day);
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }

    const handleDayPress = (day: number | null) => {
      if (!day) return;
      const d = new Date(pickerYear, pickerMonth, day);
      setInternalDate(d);
    };

    const monthNames = [
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

    const weekdaysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const goPrevMonth = () => {
      if (pickerMonth === 0) {
        setPickerMonth(11);
        setPickerYear((y) => y - 1);
      } else {
        setPickerMonth((m) => m - 1);
      }
    };

    const goNextMonth = () => {
      if (pickerMonth === 11) {
        setPickerMonth(0);
        setPickerYear((y) => y + 1);
      } else {
        setPickerMonth((m) => m + 1);
      }
    };

    const selectedDay = internalDate ? internalDate.getDate() : null;
    const selectedMonth = internalDate ? internalDate.getMonth() : null;
    const selectedYear = internalDate ? internalDate.getFullYear() : null;

    return (
      <View style={mobileStyles.calendarContainer}>
        <View style={mobileStyles.calendarHeader}>
          <TouchableOpacity onPress={goPrevMonth} style={mobileStyles.navButton}>
            <Ionicons name="chevron-back" size={18} />
          </TouchableOpacity>
          <Text style={mobileStyles.calendarHeaderText}>
            {monthNames[pickerMonth]} {pickerYear}
          </Text>
          <TouchableOpacity onPress={goNextMonth} style={mobileStyles.navButton}>
            <Ionicons name="chevron-forward" size={18} />
          </TouchableOpacity>
        </View>

        <View style={mobileStyles.weekdayRow}>
          {weekdaysShort.map((w) => (
            <Text key={w} style={mobileStyles.weekdayText}>
              {w}
            </Text>
          ))}
        </View>

        {weeks.map((w, rowIdx) => (
          <View key={rowIdx} style={mobileStyles.dayRow}>
            {w.map((day, colIdx) => {
              const isSelected = Boolean(
                day != null &&
                  selectedDay === day &&
                  selectedMonth === pickerMonth &&
                  selectedYear === pickerYear
              );
              const isToday = Boolean(
                day != null &&
                  day === todayDate.getDate() &&
                  pickerMonth === todayDate.getMonth() &&
                  pickerYear === todayDate.getFullYear()
              );

              return (
                <TouchableOpacity
                  key={`${rowIdx}-${colIdx}`}
                  style={[
                    mobileStyles.dayCell,
                    isSelected && mobileStyles.dayCellSelected,
                    isToday && mobileStyles.dayCellToday,
                  ]}
                  onPress={() => handleDayPress(day)}
                  disabled={!day}
                >
                  <Text
                    style={[
                      mobileStyles.dayText,
                      !day && mobileStyles.dayTextInactive,
                      isSelected && mobileStyles.dayTextSelected,
                      isToday && mobileStyles.dayTextToday,
                    ]}
                  >
                    {day ?? ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}

        <View style={mobileStyles.calendarFooter}>
          <TouchableOpacity onPress={() => setShow(false)} style={mobileStyles.cancelButton}>
            <Text style={mobileStyles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={applyDate}
            style={[styles.primaryButton, { paddingHorizontal: 16, paddingVertical: 8 }]}
          >
            <Text style={styles.primaryButtonText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const displayValue = value && isYMD(value) ? value : "";

  return (
    <View>
      <Text style={isMobile ? mobileStyles.formLabel : styles.inputLabel}>{label}</Text>
      <TouchableOpacity
        onPress={toggleModal}
        style={isMobile ? mobileStyles.formInputWrapper : styles.inputWrapper}
      >
        <Ionicons
          name={icon}
          size={isMobile ? 18 : 16}
          color="#64748B"
          style={isMobile ? mobileStyles.formIcon : styles.inputIcon}
        />
        <Text
          style={
            displayValue
              ? isMobile
                ? mobileStyles.formTextValue
                : styles.textValue
              : isMobile
              ? mobileStyles.formPlaceholder
              : styles.textPlaceholder
          }
        >
          {displayValue || placeholder}
        </Text>
      </TouchableOpacity>

      <Modal
        visible={show}
        transparent
        animationType="fade"
        onRequestClose={() => setShow(false)}
      >
        <View style={mobileStyles.modalOverlay}>
          <View style={mobileStyles.modalContent}>
            <Text style={mobileStyles.modalTitle}>{label}</Text>
            {renderCalendar()}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function MobileRowCard({ row, index }: { row: BillingRow; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const rocIsPositive =
    row.rate_of_change_pct != null && row.rate_of_change_pct > 0;

  return (
    <TouchableOpacity
      style={[mobileStyles.rowCard, index % 2 === 0 && mobileStyles.rowCardEven]}
      onPress={() => setExpanded(!expanded)}
      activeOpacity={0.7}
    >
      <View style={mobileStyles.rowCardHeader}>
        <View style={mobileStyles.rowCardMain}>
          <Text style={mobileStyles.rowCardStall}>
            {row.stall_sn || row.stall_no || "—"}
          </Text>
          <Text style={mobileStyles.rowCardMeter}>{row.meter_no || row.meter_id}</Text>
        </View>
        <View style={mobileStyles.rowCardRight}>
          <Text style={mobileStyles.rowCardAmount}>{formatCurrency(row.total_amount)}</Text>
          <View style={mobileStyles.rowCardKwh}>
            <Text style={mobileStyles.rowCardKwhText}>
              {fmt(row.consumed_kwh, 0)} kWh
            </Text>
          </View>
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color="#94A3B8"
        />
      </View>
      {expanded && (
        <View style={mobileStyles.rowCardDetails}>
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Meter Type</Text>
            <View style={mobileStyles.meterBadge}>
              <Text style={mobileStyles.meterBadgeText}>
                {(row.meter_type || "").toUpperCase()}
              </Text>
            </View>
          </View>
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Multiplier</Text>
            <Text style={mobileStyles.detailValue}>×{fmt(row.mult, 0)}</Text>
          </View>
          <View style={mobileStyles.divider} />
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Previous Reading</Text>
            <Text style={mobileStyles.detailValue}>{fmt(row.reading_previous, 0)}</Text>
          </View>
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Current Reading</Text>
            <Text style={mobileStyles.detailValue}>{fmt(row.reading_present, 0)}</Text>
          </View>
          <View style={mobileStyles.divider} />
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Previous Consumption</Text>
            <Text style={mobileStyles.detailValue}>
              {row.prev_consumed_kwh ? `${fmt(row.prev_consumed_kwh, 0)} kWh` : "—"}
            </Text>
          </View>
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Rate of Change</Text>
            <Text
              style={[
                mobileStyles.detailValue,
                rocIsPositive ? styles.rocPositive : styles.rocNegative,
              ]}
            >
              {row.rate_of_change_pct == null
                ? "—"
                : `${fmt(row.rate_of_change_pct, 0)}%`}
            </Text>
          </View>
          <View style={mobileStyles.divider} />
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>System Rate</Text>
            <Text style={mobileStyles.detailValue}>
              {row.system_rate == null ? "—" : fmt(row.system_rate, 4)}
            </Text>
          </View>
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>VAT Rate</Text>
            <Text style={mobileStyles.detailValue}>
              {row.vat_rate == null
                ? "—"
                : `${fmt((row.vat_rate as number) * 100, 1)}%`}
            </Text>
          </View>
          {row.whtax_code && (
            <View style={mobileStyles.detailRow}>
              <Text style={mobileStyles.detailLabel}>WHT Code</Text>
              <Text style={mobileStyles.detailValue}>{row.whtax_code}</Text>
            </View>
          )}
          <View style={mobileStyles.detailRow}>
            <Text style={mobileStyles.detailLabel}>Penalty</Text>
            <View
              style={[
                mobileStyles.penaltyBadge,
                row.for_penalty ? mobileStyles.penaltyYes : mobileStyles.penaltyNo,
              ]}
            >
              <Text
                style={[
                  mobileStyles.penaltyText,
                  row.for_penalty
                    ? mobileStyles.penaltyTextYes
                    : mobileStyles.penaltyTextNo,
                ]}
              >
                {row.for_penalty ? "YES" : "NO"}
              </Text>
            </View>
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function BillingScreen() {
  const { token, user } = useAuth();
  const { width } = useWindowDimensions();
  const isMobile = width < 768;
  const isSmallMobile = width < 400;

  const roles: string[] = Array.isArray(user?.user_roles) ? user!.user_roles : [];
  const isAdmin = roles.includes("admin");
  const isBiller = roles.includes("biller");
  const noAccess = !isAdmin && !isBiller;

  const headerToken =
    token && /^Bearer\s/i.test(token.trim())
      ? token.trim()
      : token
      ? `Bearer ${token.trim()}`
      : "";
  const api = useMemo(
    () =>
      axios.create({
        baseURL: BASE_API,
        timeout: 20000,
        headers: headerToken ? { Authorization: headerToken } : {},
      }),
    [headerToken]
  );

  const [buildingId, setBuildingId] = useState("");
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [startDate, setStartDate] = useState<string>(() => {
    const d = new Date();
    const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
    const m = d.getMonth() === 0 ? 11 : d.getMonth() - 1;
    return `${y}-${String(m + 1).padStart(2, "0")}-21`;
  });
  const [endDate, setEndDate] = useState<string>(() => today());
  const [penaltyRate, setPenaltyRate] = useState<string>("0");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [payload, setPayload] = useState<BuildingBillingResponse | null>(null);
  const [storedBillings, setStoredBillings] = useState<
    Record<string, StoredBilling>
  >({});
  const [error, setError] = useState<string>("");
  const [viewTab, setViewTab] = useState<"billing" | "roc">("billing");
  const [modeTab, setModeTab] = useState<"generate" | "stored">("generate");

  const canRun =
    !!buildingId && isYMD(startDate) && isYMD(endDate) && !!token && !busy;

  useEffect(() => {
    const loadBuildings = async () => {
      if (!token) return;
      try {
        const res = await api.get<BuildingOption[]>("/buildings");
        setBuildings(Array.isArray(res.data) ? res.data : []);
      } catch (e) {
        console.error("Fetch buildings for billing failed:", e);
      }
    };
    loadBuildings();
  }, [api, token]);

  const fetchStoredBillings = async () => {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.get<Record<string, StoredBilling>>(
        "/billings/buildings"
      );
      setStoredBillings(res.data || {});
    } catch (e: any) {
      const msg =
        e?.response?.data?.error ??
        e?.message ??
        "Unable to fetch stored billings.";
      setError(msg);
      notify("Fetch failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const fetchStoredBilling = async (buildingBillingId: string) => {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.get<BuildingBillingResponse>(
        `/billings/buildings/${encodeURIComponent(buildingBillingId)}`
      );
      setPayload(res.data);
      setModeTab("generate");
    } catch (e: any) {
      const msg =
        e?.response?.data?.error ?? e?.message ?? "Unable to fetch billing.";
      setError(msg);
      notify("Fetch failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const onCreateBilling = async () => {
    if (!token) return notify("Not logged in", "Please sign in first.");
    if (!buildingId.trim())
      return notify("Missing building", "Select a building.");
    if (!isYMD(startDate) || !isYMD(endDate))
      return notify("Invalid dates", "Use YYYY-MM-DD.");

    const penaltyNum = num(penaltyRate);
    if (penaltyNum == null || penaltyNum < 0)
      return notify("Invalid penalty", "Enter a valid percentage.");

    setCreating(true);
    setError("");
    try {
      const res = await api.post<BuildingBillingResponse>(
        `/billings/buildings/${encodeURIComponent(
          buildingId.trim()
        )}/period-start/${encodeURIComponent(
          startDate
        )}/period-end/${encodeURIComponent(endDate)}`,
        {},
        { params: { penalty_rate: penaltyNum } }
      );
      setPayload(res.data);
      await fetchStoredBillings();
      notify("Success", "Billing created and saved successfully.");
    } catch (e: any) {
      const status = e?.response?.status;
      const existingId = e?.response?.data?.building_billing_id;
      const msg =
        e?.response?.data?.error ??
        e?.message ??
        "Unable to create building billing.";
      setError(msg);

      if (status === 409 && existingId) {
        notify(
          "Already exists",
          "Billing already exists for this building and period. Loading it instead."
        );
        await fetchStoredBilling(existingId);
        await fetchStoredBillings();
      } else {
        notify("Request failed", msg);
      }
    } finally {
      setCreating(false);
    }
  };

  const onExportCurrentCsv = () => {
    if (!payload) return;
    const { filename, csv } = makeBillingCsv(payload);
    saveCsv(filename, csv);
  };

  const onDownloadStoredCsv = async (billing: StoredBilling) => {
    if (!token) return;
    if (!billing.payload) {
      await fetchStoredBilling(billing.building_billing_id);
      if (!payload) return;
      const { filename, csv } = makeBillingCsv(payload);
      saveCsv(filename, csv);
      return;
    }
    try {
      setBusy(true);
      const { filename, csv } = makeBillingCsv(billing.payload);
      saveCsv(filename, csv);
    } catch (e: any) {
      notify(
        "Download failed",
        e?.message ?? "Unable to download billing report."
      );
    } finally {
      setBusy(false);
    }
  };

  if (noAccess) {
    return (
      <View style={styles.noAccessContainer}>
        <Ionicons name="lock-closed-outline" size={40} color="#94A3B8" />
        <Text style={styles.noAccessTitle}>Access denied</Text>
        <Text style={styles.noAccessText}>
          You do not have permission to access the Billing module.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={[styles.header, isMobile && mobileStyles.header]}>
        <Text style={[styles.title, isMobile && mobileStyles.title]}>
          Billing & Statements
        </Text>
        <Text
          style={[styles.subtitle, isMobile && mobileStyles.subtitle]}
        >
          {isMobile
            ? "Generate billing and export CSV"
            : "Generate per-building billing, export CSV, and manage stored billings."}
        </Text>
      </View>

      <View style={[styles.tabContainer, isMobile && mobileStyles.tabContainer]}>
        <TouchableOpacity
          style={[
            styles.tab,
            viewTab === "billing" && styles.tabActive,
            isMobile && mobileStyles.tab,
          ]}
          onPress={() => setViewTab("billing")}
        >
          <Ionicons
            name="document-text-outline"
            size={isMobile ? 18 : 16}
            color={viewTab === "billing" ? "#2563EB" : "#64748B"}
          />
          <Text
            style={[
              styles.tabText,
              viewTab === "billing" && styles.tabTextActive,
              isMobile && mobileStyles.tabText,
            ]}
          >
            Billing
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tab,
            viewTab === "roc" && styles.tabActive,
            isMobile && mobileStyles.tab,
          ]}
          onPress={() => setViewTab("roc")}
        >
          <Ionicons
            name="trending-up-outline"
            size={isMobile ? 18 : 16}
            color={viewTab === "roc" ? "#2563EB" : "#64748B"}
          />
          <Text
            style={[
              styles.tabText,
              viewTab === "roc" && styles.tabTextActive,
              isMobile && mobileStyles.tabText,
            ]}
          >
            ROC
          </Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.content, isMobile && mobileStyles.content]}>
        {viewTab === "billing" ? (
          <View>
            <View
              style={[styles.modeToggle, isMobile && mobileStyles.modeToggle]}
            >
              <TouchableOpacity
                style={[
                  styles.modeTab,
                  modeTab === "generate" && styles.modeTabActive,
                ]}
                onPress={() => setModeTab("generate")}
              >
                <Text
                  style={[
                    styles.modeTabText,
                    modeTab === "generate" && styles.modeTabTextActive,
                  ]}
                >
                  {isMobile ? "Generate" : "Generate Billing"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modeTab,
                  modeTab === "stored" && styles.modeTabActive,
                ]}
                onPress={() => {
                  setModeTab("stored");
                  fetchStoredBillings();
                }}
              >
                <Text
                  style={[
                    styles.modeTabText,
                    modeTab === "stored" && styles.modeTabTextActive,
                  ]}
                >
                  {isMobile ? "Stored" : "Stored Billings"}
                </Text>
              </TouchableOpacity>
            </View>

            {modeTab === "generate" ? (
              <>
                <View
                  style={[styles.inputCard, isMobile && mobileStyles.inputCard]}
                >
                  <View style={styles.cardHeader}>
                    <Ionicons name="calculator" size={20} color="#2563EB" />
                    <Text style={styles.cardTitle}>
                      {isMobile ? "Parameters" : "Billing Parameters"}
                    </Text>
                  </View>

                  {isMobile ? (
                    <View style={mobileStyles.formContainer}>
                      <View style={mobileStyles.formGroup}>
                        <Text style={mobileStyles.formLabel}>Building *</Text>
                        <View style={mobileStyles.formInputWrapper}>
                          <Ionicons
                            name="business"
                            size={18}
                            color="#64748B"
                            style={mobileStyles.formIcon}
                          />
                          {buildings.length > 0 ? (
                            <Picker
                              selectedValue={buildingId}
                              onValueChange={(v) =>
                                setBuildingId(String(v))
                              }
                              style={mobileStyles.formPicker}
                              mode={
                                Platform.OS === "android"
                                  ? "dropdown"
                                  : undefined
                              }
                            >
                              <Picker.Item
                                label="Select building…"
                                value=""
                              />
                              {buildings.map((b) => (
                                <Picker.Item
                                  key={b.building_id}
                                  label={
                                    b.building_name
                                      ? `${b.building_name}`
                                      : b.building_id
                                  }
                                  value={b.building_id}
                                />
                              ))}
                            </Picker>
                          ) : (
                            <TextInput
                              value={buildingId}
                              onChangeText={setBuildingId}
                              placeholder="Enter building ID"
                              style={mobileStyles.formTextInput}
                              autoCapitalize="characters"
                              autoCorrect={false}
                            />
                          )}
                        </View>
                      </View>

                      <View style={mobileStyles.dateRow}>
                        <View style={mobileStyles.dateField}>
                          <CalendarDatePicker
                            label="Start Date *"
                            value={startDate}
                            onChangeText={setStartDate}
                            placeholder="Select start"
                            icon="calendar"
                            isMobile={isMobile}
                          />
                        </View>
                        <View style={mobileStyles.dateField}>
                          <CalendarDatePicker
                            label="End Date *"
                            value={endDate}
                            onChangeText={setEndDate}
                            placeholder="Select end"
                            icon="calendar"
                            isMobile={isMobile}
                          />
                        </View>
                      </View>

                      <View style={mobileStyles.formGroup}>
                        <Text style={mobileStyles.formLabel}>
                          Penalty Rate (%) *
                        </Text>
                        <View style={mobileStyles.formInputWrapper}>
                          <Ionicons
                            name="alert-circle"
                            size={18}
                            color="#64748B"
                            style={mobileStyles.formIcon}
                          />
                          <TextInput
                            value={penaltyRate}
                            onChangeText={setPenaltyRate}
                            placeholder="0"
                            style={mobileStyles.formTextInput}
                            keyboardType="numeric"
                          />
                          <Text style={mobileStyles.formSuffix}>%</Text>
                        </View>
                      </View>
                    </View>
                  ) : (
                    <View style={styles.inputGrid}>
                      <View style={styles.inputGroup}>
                        <Text style={styles.inputLabel}>Building *</Text>
                        <View style={styles.inputWrapper}>
                          <Ionicons
                            name="business"
                            size={16}
                            color="#64748B"
                            style={styles.inputIcon}
                          />
                          {buildings.length > 0 ? (
                            <Picker
                              selectedValue={buildingId}
                              onValueChange={(v) =>
                                setBuildingId(String(v))
                              }
                              style={styles.picker}
                              mode={
                                Platform.OS === "android"
                                  ? "dropdown"
                                  : undefined
                              }
                            >
                              <Picker.Item
                                label="Select building…"
                                value=""
                              />
                              {buildings.map((b) => (
                                <Picker.Item
                                  key={b.building_id}
                                  label={
                                    b.building_name
                                      ? `${b.building_name} (${b.building_id})`
                                      : b.building_id
                                  }
                                  value={b.building_id}
                                />
                              ))}
                            </Picker>
                          ) : (
                            <TextInput
                              value={buildingId}
                              onChangeText={setBuildingId}
                              placeholder="BLDG-001"
                              style={styles.textInput}
                              autoCapitalize="characters"
                              autoCorrect={false}
                            />
                          )}
                        </View>
                      </View>
                      <View style={styles.inputGroup}>
                        <CalendarDatePicker
                          label="Start Date *"
                          value={startDate}
                          onChangeText={setStartDate}
                          placeholder="YYYY-MM-DD"
                          icon="calendar"
                          isMobile={false}
                        />
                      </View>
                      <View style={styles.inputGroup}>
                        <CalendarDatePicker
                          label="End Date *"
                          value={endDate}
                          onChangeText={setEndDate}
                          placeholder="YYYY-MM-DD"
                          icon="calendar"
                          isMobile={false}
                        />
                      </View>
                      <View style={styles.inputGroup}>
                        <Text style={styles.inputLabel}>
                          Penalty Rate (%) *
                        </Text>
                        <View style={styles.inputWrapper}>
                          <Ionicons
                            name="alert-circle"
                            size={16}
                            color="#64748B"
                            style={styles.inputIcon}
                          />
                          <TextInput
                            value={penaltyRate}
                            onChangeText={setPenaltyRate}
                            placeholder="0"
                            style={styles.textInput}
                            keyboardType="numeric"
                          />
                        </View>
                      </View>
                    </View>
                  )}

                  {isMobile ? (
                    <View style={mobileStyles.actionRow}>
                      <TouchableOpacity
                        style={[
                          styles.primaryButton,
                          mobileStyles.primaryButton,
                          !canRun && styles.buttonDisabled,
                        ]}
                        onPress={onCreateBilling}
                        disabled={!canRun || creating}
                      >
                        {creating ? (
                          <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                          <Ionicons name="save" size={18} color="#FFFFFF" />
                        )}
                        <Text style={styles.primaryButtonText}>
                          {creating ? "Creating." : "Create Billing"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.secondaryButton,
                          mobileStyles.secondaryButton,
                          !payload && styles.buttonDisabled,
                        ]}
                        onPress={onExportCurrentCsv}
                        disabled={!payload}
                      >
                        <Ionicons
                          name="download"
                          size={18}
                          color="#2563EB"
                        />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.actionRow}>
                      <TouchableOpacity
                        style={[
                          styles.primaryButton,
                          !canRun && styles.buttonDisabled,
                        ]}
                        onPress={onCreateBilling}
                        disabled={!canRun || creating}
                      >
                        {creating ? (
                          <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                          <Ionicons name="save" size={16} color="#FFFFFF" />
                        )}
                        <Text style={styles.primaryButtonText}>
                          {creating ? "Creating..." : "Create & Save Billing"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.secondaryButton,
                          !payload && styles.buttonDisabled,
                        ]}
                        onPress={onExportCurrentCsv}
                        disabled={!payload}
                      >
                        <Ionicons
                          name="download"
                          size={16}
                          color="#2563EB"
                        />
                        <Text style={styles.secondaryButtonText}>
                          Export CSV
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {error ? (
                    <Text style={styles.errorText}>{error}</Text>
                  ) : null}
                </View>

                <View
                  style={[
                    styles.billingCard,
                    isMobile && mobileStyles.billingCard,
                  ]}
                >
                  {payload ? (
                    <View
                      style={[
                        styles.billingSummary,
                        isMobile && mobileStyles.billingSummary,
                      ]}
                    >
                      <View style={styles.cardHeader}>
                        <Ionicons name="business" size={20} color="#2563EB" />
                        <Text style={styles.cardTitle}>Summary</Text>
                        {payload.building_billing_id && !isMobile && (
                          <Text style={styles.billingId}>
                            ID: {payload.building_billing_id}
                          </Text>
                        )}
                      </View>
                      <View
                        style={[
                          styles.summaryGrid,
                          isMobile && mobileStyles.summaryGrid,
                        ]}
                      >
                        <View
                          style={[
                            styles.summaryItem,
                            isMobile && mobileStyles.summaryItem,
                          ]}
                        >
                          <Text style={styles.summaryLabel}>Building</Text>
                          <Text
                            style={[
                              styles.summaryValue,
                              isMobile && { fontSize: 13 },
                            ]}
                          >
                            {payload.building_id}
                            {payload.building_name
                              ? ` • ${payload.building_name}`
                              : ""}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.summaryItem,
                            isMobile && mobileStyles.summaryItem,
                          ]}
                        >
                          <Text style={styles.summaryLabel}>Period</Text>
                          <Text
                            style={[
                              styles.summaryValue,
                              isMobile && { fontSize: 13 },
                            ]}
                          >
                            {payload.period.start} → {payload.period.end}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.summaryItem,
                            isMobile && mobileStyles.summaryItem,
                          ]}
                        >
                          <Text style={styles.summaryLabel}>Consumption</Text>
                          <Text
                            style={[
                              styles.summaryValue,
                              isMobile && { fontSize: 13 },
                            ]}
                          >
                            {fmt(payload.totals.total_consumed_kwh, 4)} kWh
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.summaryItem,
                            isMobile && mobileStyles.summaryItem,
                          ]}
                        >
                          <Text style={styles.summaryLabel}>Total Amount</Text>
                          <Text
                            style={[
                              styles.summaryValue,
                              styles.amountValue,
                              isMobile && { fontSize: 15 },
                            ]}
                          >
                            {formatCurrency(payload.totals.total_amount)}
                          </Text>
                        </View>
                      </View>
                      {payload.generated_at && (
                        <Text style={styles.generatedAt}>
                          Generated at{" "}
                          {new Date(
                            payload.generated_at
                          ).toLocaleString()}
                        </Text>
                      )}
                    </View>
                  ) : (
                    <View
                      style={[
                        styles.placeholderCard,
                        isMobile && mobileStyles.placeholderCard,
                      ]}
                    >
                      <Ionicons
                        name="document-text"
                        size={isMobile ? 40 : 48}
                        color="#CBD5E1"
                      />
                      <Text style={styles.placeholderTitle}>
                        No Billing Data
                      </Text>
                      <Text style={styles.placeholderText}>
                        {isMobile
                          ? "Create billing to see results"
                          : "Enter building details and create billing to see results"}
                      </Text>
                    </View>
                  )}

                  {payload && (
                    <View style={{ marginTop: 16, gap: 16 }}>
                      {payload.tenants.map((tenant, tenantIndex) => (
                        <View
                          key={
                            tenant.tenant_id || `tenant-${tenantIndex}`
                          }
                          style={[
                            styles.tenantCard,
                            isMobile && mobileStyles.tenantCard,
                          ]}
                        >
                          <View style={styles.tenantHeader}>
                            <Ionicons
                              name="person"
                              size={18}
                              color="#374151"
                            />
                            <View style={styles.tenantInfo}>
                              <Text
                                style={[
                                  styles.tenantName,
                                  isMobile && { fontSize: 14 },
                                ]}
                              >
                                {tenant.tenant_name ||
                                  tenant.tenant_id ||
                                  "Unassigned Tenant"}
                              </Text>
                              {tenant.tenant_sn && (
                                <Text style={styles.tenantId}>
                                  {tenant.tenant_sn}
                                </Text>
                              )}
                            </View>
                          </View>

                          {isMobile ? (
                            <View style={mobileStyles.rowCardContainer}>
                              {tenant.rows.map((row, rowIndex) => (
                                <MobileRowCard
                                  key={`${row.meter_id}-${rowIndex}`}
                                  row={row}
                                  index={rowIndex}
                                />
                              ))}
                            </View>
                          ) : (
                            <View style={styles.compactTable}>
                              <View style={styles.compactTableHeader}>
                                <View
                                  style={[
                                    styles.compactCell,
                                    styles.compactCellHeader,
                                    { flex: 2 },
                                  ]}
                                >
                                  <Text style={styles.compactHeaderText}>
                                    Stall/Meter
                                  </Text>
                                </View>
                                <View
                                  style={[
                                    styles.compactCell,
                                    styles.compactCellHeader,
                                    { flex: 1.5 },
                                  ]}
                                >
                                  <Text style={styles.compactHeaderText}>
                                    Readings
                                  </Text>
                                </View>
                                <View
                                  style={[
                                    styles.compactCell,
                                    styles.compactCellHeader,
                                    { flex: 1 },
                                  ]}
                                >
                                  <Text style={styles.compactHeaderText}>
                                    Consumption
                                  </Text>
                                </View>
                                <View
                                  style={[
                                    styles.compactCell,
                                    styles.compactCellHeader,
                                    { flex: 1 },
                                  ]}
                                >
                                  <Text style={styles.compactHeaderText}>
                                    ROC
                                  </Text>
                                </View>
                                <View
                                  style={[
                                    styles.compactCell,
                                    styles.compactCellHeader,
                                    { flex: 1.5 },
                                  ]}
                                >
                                  <Text style={styles.compactHeaderText}>
                                    Rates & Taxes
                                  </Text>
                                </View>
                                <View
                                  style={[
                                    styles.compactCell,
                                    styles.compactCellHeader,
                                    { flex: 1 },
                                  ]}
                                >
                                  <Text style={styles.compactHeaderText}>
                                    Amount
                                  </Text>
                                </View>
                              </View>
                              {tenant.rows.map((row, rowIndex) => (
                                <View
                                  key={`${row.meter_id}-${rowIndex}`}
                                  style={[
                                    styles.compactTableRow,
                                    rowIndex % 2 === 0 &&
                                      styles.compactTableRowEven,
                                  ]}
                                >
                                  <View
                                    style={[styles.compactCell, { flex: 2 }]}
                                  >
                                    <Text
                                      style={styles.compactCellPrimary}
                                    >
                                      {row.stall_sn ||
                                        row.stall_no ||
                                        "—"}
                                    </Text>
                                    <Text
                                      style={styles.compactCellSecondary}
                                    >
                                      {row.meter_no || row.meter_id}
                                    </Text>
                                    <View style={styles.meterTypeBadge}>
                                      <Text style={styles.meterTypeText}>
                                        {(row.meter_type || "")
                                          .toUpperCase()}
                                      </Text>
                                      <Text style={styles.multiplierText}>
                                        ×{fmt(row.mult, 0)}
                                      </Text>
                                    </View>
                                  </View>
                                  <View
                                    style={[
                                      styles.compactCell,
                                      { flex: 1.5 },
                                    ]}
                                  >
                                    <View style={styles.readingPair}>
                                      <Text style={styles.readingLabel}>
                                        Prev:
                                      </Text>
                                      <Text style={styles.readingValue}>
                                        {fmt(row.reading_previous, 0)}
                                      </Text>
                                    </View>
                                    <View style={styles.readingPair}>
                                      <Text style={styles.readingLabel}>
                                        Curr:
                                      </Text>
                                      <Text style={styles.readingValue}>
                                        {fmt(row.reading_present, 0)}
                                      </Text>
                                    </View>
                                  </View>
                                  <View
                                    style={[
                                      styles.compactCell,
                                      { flex: 1 },
                                    ]}
                                  >
                                    <Text
                                      style={styles.consumptionValue}
                                    >
                                      {fmt(row.consumed_kwh, 0)} kWh
                                    </Text>
                                    {row.prev_consumed_kwh && (
                                      <Text
                                        style={
                                          styles.previousConsumption
                                        }
                                      >
                                        Prev:{" "}
                                        {fmt(row.prev_consumed_kwh, 0)}
                                      </Text>
                                    )}
                                  </View>
                                  <View
                                    style={[
                                      styles.compactCell,
                                      { flex: 1 },
                                    ]}
                                  >
                                    <Text
                                      style={[
                                        styles.rocValue,
                                        row.rate_of_change_pct &&
                                        row.rate_of_change_pct > 0
                                          ? styles.rocPositive
                                          : styles.rocNegative,
                                      ]}
                                    >
                                      {row.rate_of_change_pct == null
                                        ? "—"
                                        : `${fmt(
                                            row.rate_of_change_pct,
                                            0
                                          )}%`}
                                    </Text>
                                  </View>
                                  <View
                                    style={[
                                      styles.compactCell,
                                      { flex: 1.5 },
                                    ]}
                                  >
                                    <View style={styles.ratesContainer}>
                                      <Text style={styles.rateText}>
                                        System:{" "}
                                        {row.system_rate == null
                                          ? "—"
                                          : fmt(row.system_rate, 4)}
                                      </Text>
                                      <Text style={styles.rateText}>
                                        VAT:{" "}
                                        {row.vat_rate == null
                                          ? "—"
                                          : `${fmt(
                                              (row.vat_rate as number) *
                                                100,
                                              1
                                            )}%`}
                                      </Text>
                                      {row.whtax_code && (
                                        <Text style={styles.rateText}>
                                          WHT: {row.whtax_code}
                                        </Text>
                                      )}
                                      <Text
                                        style={[
                                          styles.penaltyBadge,
                                          row.for_penalty
                                            ? styles.penaltyYes
                                            : styles.penaltyNo,
                                        ]}
                                      >
                                        {row.for_penalty
                                          ? "PENALTY"
                                          : "NO PENALTY"}
                                      </Text>
                                    </View>
                                  </View>
                                  <View
                                    style={[
                                      styles.compactCell,
                                      { flex: 1 },
                                    ]}
                                  >
                                    <Text style={styles.amountText}>
                                      {formatCurrency(row.total_amount)}
                                    </Text>
                                  </View>
                                </View>
                              ))}
                            </View>
                          )}

                          <View
                            style={[
                              styles.tenantTotal,
                              isMobile && mobileStyles.tenantTotal,
                            ]}
                          >
                            <Text style={styles.tenantTotalLabel}>
                              Tenant Total:
                            </Text>
                            <Text
                              style={[
                                styles.tenantTotalAmount,
                                isMobile && { fontSize: 15 },
                              ]}
                            >
                              {formatCurrency(
                                tenant.rows.reduce(
                                  (sum, row) => sum + row.total_amount,
                                  0
                                )
                              )}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              </>
            ) : (
              <View
                style={[
                  styles.storedBillingsCard,
                  isMobile && mobileStyles.storedBillingsCard,
                ]}
              >
                <View style={styles.cardHeader}>
                  <Ionicons name="archive" size={20} color="#2563EB" />
                  <Text style={styles.cardTitle}>Stored Billings</Text>
                  <TouchableOpacity
                    onPress={fetchStoredBillings}
                    style={styles.refreshButton}
                  >
                    <Ionicons
                      name="refresh"
                      size={16}
                      color="#64748B"
                    />
                  </TouchableOpacity>
                </View>
                {busy ? (
                  <ActivityIndicator
                    size="large"
                    color="#2563EB"
                    style={styles.loader}
                  />
                ) : Object.keys(storedBillings).length === 0 ? (
                  <View style={styles.placeholderCard}>
                    <Ionicons
                      name="archive-outline"
                      size={48}
                      color="#CBD5E1"
                    />
                    <Text style={styles.placeholderTitle}>
                      No Stored Billings
                    </Text>
                    <Text style={styles.placeholderText}>
                      Generate new billings to see them stored here
                    </Text>
                  </View>
                ) : (
                  <View style={styles.billingList}>
                    {Object.values(storedBillings).map((billing) => (
                      <TouchableOpacity
                        key={billing.building_billing_id}
                        style={[
                          styles.billingItem,
                          isMobile && mobileStyles.billingItem,
                        ]}
                        onPress={() =>
                          fetchStoredBilling(billing.building_billing_id)
                        }
                      >
                        <View style={styles.billingInfo}>
                          <Text
                            style={[
                              styles.billingTitle,
                              isMobile && { fontSize: 13 },
                            ]}
                          >
                            {billing.building_id}
                            {billing.building_name
                              ? ` • ${billing.building_name}`
                              : ""}
                          </Text>
                          <Text style={styles.billingPeriod}>
                            {billing.period.start} → {billing.period.end}
                          </Text>
                          <Text style={styles.billingTotals}>
                            {fmt(billing.totals.total_consumed_kwh, 4)} kWh •{" "}
                            {formatCurrency(billing.totals.total_amount)}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.downloadButton}
                          onPress={() => onDownloadStoredCsv(billing)}
                        >
                          <Ionicons
                            name="download-outline"
                            size={16}
                            color="#2563EB"
                          />
                          <Text style={styles.downloadButtonText}>CSV</Text>
                        </TouchableOpacity>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        ) : (
          <View style={styles.rocSection}>
            <RateOfChangePanel />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F8FAFC" },
  noAccessContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#EFF6FF",
    gap: 12,
  },
  noAccessTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  noAccessText: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    maxWidth: 320,
  },
  header: {
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  title: { fontSize: 28, fontWeight: "700", color: "#0F172A", marginBottom: 8 },
  subtitle: { fontSize: 16, color: "#64748B", lineHeight: 24 },
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    paddingHorizontal: 24,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    gap: 8,
  },
  tabActive: { borderBottomColor: "#2563EB" },
  tabText: { fontSize: 14, fontWeight: "600", color: "#64748B" },
  tabTextActive: { color: "#2563EB" },
  content: {
    padding: 24,
    maxWidth: 1200,
    width: "100%",
    alignSelf: "center",
  },
  rocSection: { padding: 24 },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    borderRadius: 999,
    padding: 4,
    marginBottom: 16,
    alignSelf: "flex-start",
  },
  modeTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  modeTabActive: { backgroundColor: "#EFF6FF" },
  modeTabText: { fontSize: 14, fontWeight: "600", color: "#64748B" },
  modeTabTextActive: { color: "#2563EB" },
  inputCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: "#000000",
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: "#0F172A" },
  inputGrid: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  inputGroup: { flex: 1, minWidth: 180 },
  inputLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: "#4B5563",
    marginBottom: 4,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 999,
    paddingHorizontal: 10,
    backgroundColor: "#F9FAFB",
  },
  inputIcon: { marginRight: 6 },
  textInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: "#111827",
  },
  textValue: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: "#111827",
  },
  textPlaceholder: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: "#9CA3AF",
  },
  picker: { flex: 1, height: 40 },
  actionRow: {
    flexDirection: "row",
    marginTop: 16,
    gap: 12,
    alignItems: "center",
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2563EB",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: "#FFFFFF",
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#2563EB",
  },
  buttonDisabled: { opacity: 0.5 },
  errorText: {
    marginTop: 8,
    fontSize: 13,
    color: "#DC2626",
  },
  billingCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
    shadowColor: "#000000",
    shadowOpacity: 0.03,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 1,
  },
  billingSummary: { marginBottom: 16 },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  summaryItem: { flexBasis: "48%" },
  summaryLabel: { fontSize: 12, color: "#6B7280", marginBottom: 4 },
  summaryValue: { fontSize: 14, fontWeight: "500", color: "#111827" },
  amountValue: { color: "#16A34A" },
  generatedAt: {
    marginTop: 8,
    fontSize: 12,
    color: "#6B7280",
  },
  placeholderCard: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 12,
  },
  placeholderTitle: { fontSize: 16, fontWeight: "600", color: "#111827" },
  placeholderText: { fontSize: 13, color: "#6B7280", textAlign: "center" },
  tenantCard: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    padding: 12,
    backgroundColor: "#FFFFFF",
  },
  tenantHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  tenantInfo: { flex: 1 },
  tenantName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  tenantId: { fontSize: 12, color: "#6B7280" },
  compactTable: { marginTop: 8 },
  compactTableHeader: {
    flexDirection: "row",
    backgroundColor: "#F3F4F6",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  compactCell: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "#E5E7EB",
  },
  compactCellHeader: { borderBottomWidth: 1, borderBottomColor: "#E5E7EB" },
  compactHeaderText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
  },
  compactTableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  compactTableRowEven: { backgroundColor: "#F9FAFB" },
  compactCellPrimary: {
    fontSize: 13,
    fontWeight: "500",
    color: "#111827",
  },
  compactCellSecondary: { fontSize: 11, color: "#6B7280" },
  meterTypeBadge: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  meterTypeText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#1D4ED8",
    backgroundColor: "#DBEAFE",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  multiplierText: { fontSize: 10, color: "#6B7280" },
  readingPair: { flexDirection: "row", gap: 4 },
  readingLabel: { fontSize: 11, color: "#6B7280" },
  readingValue: { fontSize: 12, fontWeight: "500", color: "#111827" },
  consumptionValue: { fontSize: 12, fontWeight: "500", color: "#111827" },
  previousConsumption: { fontSize: 11, color: "#6B7280" },
  rocValue: { fontSize: 12, fontWeight: "600" },
  rocPositive: { color: "#16A34A" },
  rocNegative: { color: "#DC2626" },
  ratesContainer: { gap: 2 },
  rateText: { fontSize: 11, color: "#4B5563" },
  penaltyBadge: {
    marginTop: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    fontSize: 10,
    fontWeight: "600",
  },
  penaltyYes: { backgroundColor: "#FEE2E2", color: "#B91C1C" },
  penaltyNo: { backgroundColor: "#DCFCE7", color: "#15803D" },
  amountText: { fontSize: 13, fontWeight: "600", color: "#111827" },
  tenantTotal: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  tenantTotalLabel: { fontSize: 12, color: "#6B7280" },
  tenantTotalAmount: { fontSize: 13, fontWeight: "600", color: "#111827" },
  storedBillingsCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
  },
  loader: { marginTop: 16 },
  billingList: { marginTop: 8 },
  billingItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 8,
    gap: 8,
  },
  billingInfo: { flex: 1 },
  billingTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
    marginBottom: 2,
  },
  billingPeriod: { fontSize: 12, color: "#6B7280" },
  billingTotals: { fontSize: 12, color: "#4B5563", marginTop: 2 },
  downloadButton: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
    backgroundColor: "#EFF6FF",
  },
  downloadButtonText: {
    fontSize: 12,
    fontWeight: "500",
    color: "#2563EB",
  },
  refreshButton: {
    marginLeft: "auto",
    padding: 6,
    borderRadius: 999,
    backgroundColor: "#F3F4F6",
  },
  billingId: { marginLeft: "auto", fontSize: 12, color: "#6B7280" },
});

const mobileStyles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingVertical: 16 },
  title: { fontSize: 22 },
  subtitle: { fontSize: 13 },
  tabContainer: { paddingHorizontal: 12 },
  tab: { flex: 1, justifyContent: "center" },
  tabText: { fontSize: 13 },
  content: { paddingHorizontal: 12, paddingBottom: 24 },
  modeToggle: {
    alignSelf: "stretch",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  inputCard: { padding: 12 },
  formContainer: { gap: 12 },
  formGroup: { gap: 4 },
  formLabel: { fontSize: 13, fontWeight: "500", color: "#4B5563" },
  formInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 999,
    paddingHorizontal: 10,
    backgroundColor: "#F9FAFB",
  },
  formIcon: { marginRight: 6 },
  formTextInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: "#111827",
  },
  formTextValue: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: "#111827",
  },
  formPlaceholder: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: "#9CA3AF",
  },
  formPicker: { flex: 1, height: 40 },
  formSuffix: { fontSize: 13, color: "#6B7280", marginLeft: 4 },
  dateRow: { flexDirection: "row", gap: 8 },
  dateField: { flex: 1 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    gap: 8,
  },
  primaryButton: { flex: 1, justifyContent: "center" },
  secondaryButton: {
    width: 44,
    height: 44,
    borderRadius: 999,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  billingCard: { padding: 12, marginTop: 12 },
  billingSummary: {},
  summaryGrid: { flexDirection: "column", gap: 8 },
  summaryItem: { flexBasis: "100%" },
  placeholderCard: { paddingVertical: 24 },
  tenantCard: { padding: 10 },
  rowCardContainer: { gap: 8, marginTop: 8 },
  rowCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 10,
    backgroundColor: "#FFFFFF",
  },
  rowCardEven: { backgroundColor: "#F9FAFB" },
  rowCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowCardMain: { flex: 1 },
  rowCardStall: { fontSize: 14, fontWeight: "600", color: "#111827" },
  rowCardMeter: { fontSize: 12, color: "#6B7280" },
  rowCardRight: { alignItems: "flex-end" },
  rowCardAmount: { fontSize: 14, fontWeight: "600", color: "#111827" },
  rowCardKwh: {
    marginTop: 2,
    backgroundColor: "#EFF6FF",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  rowCardKwhText: {
    fontSize: 11,
    fontWeight: "500",
    color: "#1D4ED8",
  },
  rowCardDetails: { marginTop: 10, gap: 8 },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  detailLabel: { fontSize: 12, color: "#6B7280" },
  detailValue: { fontSize: 12, fontWeight: "500", color: "#111827" },
  divider: {
    height: 1,
    backgroundColor: "#E5E7EB",
    marginVertical: 4,
  },
  meterBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "#DBEAFE",
  },
  meterBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#1D4ED8",
  },
  penaltyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  penaltyYes: { backgroundColor: "#FEE2E2" },
  penaltyNo: { backgroundColor: "#DCFCE7" },
  penaltyText: { fontSize: 11, fontWeight: "600" },
  penaltyTextYes: { color: "#B91C1C" },
  penaltyTextNo: { color: "#15803D" },
  tenantTotal: { marginTop: 8 },
  storedBillingsCard: { padding: 12 },
  billingItem: { paddingVertical: 8, paddingHorizontal: 10 },
  tenantTotalAmount: { fontSize: 13, fontWeight: "600", color: "#111827" },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.5)",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalContent: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111827",
    marginBottom: 8,
  },
  calendarContainer: { marginTop: 4 },
  calendarHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  navButton: {
    padding: 4,
    borderRadius: 999,
    backgroundColor: "#EFF6FF",
  },
  calendarHeaderText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
  },
  weekdayRow: {
    flexDirection: "row",
    marginTop: 8,
    marginBottom: 4,
  },
  weekdayText: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "500",
    color: "#6B7280",
  },
  dayRow: { flexDirection: "row" },
  dayCell: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  dayCellSelected: { backgroundColor: "#2563EB" },
  dayCellToday: { borderWidth: 1, borderColor: "#2563EB" },
  dayText: { fontSize: 14, color: "#374151" },
  dayTextInactive: { color: "#94A3B8" },
  dayTextSelected: { color: "#FFFFFF", fontWeight: "600" },
  dayTextToday: { color: "#2563EB", fontWeight: "600" },
  calendarFooter: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#F1F5F9",
    alignItems: "flex-end",
  },
  cancelButton: { paddingVertical: 8, paddingHorizontal: 16 },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#64748B",
  },
});