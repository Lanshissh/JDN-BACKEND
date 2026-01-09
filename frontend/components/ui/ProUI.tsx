import React from "react";
import { Platform, View, Text, TouchableOpacity, TextInput, Modal, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

/** ---- Tokens ---- */
export const tokens = {
  color: {
    bg: "#f6f8fb",
    card: "#ffffff",
    ink: "#102a43",
    inkSubtle: "#3c4c5d",
    inkMuted: "#6b7b8a",
    brand: "#2563eb",
    brandAlt: "#7c3aed",
    success: "#16a34a",
    warn: "#d97706",
    danger: "#ef4444",
    line: "#e6ebf2",
    focus: "#93c5fd",
    chipBg: "#eef2ff",
  },
  radius: { xs: 6, sm: 10, md: 14, lg: 20, xl: 28 },
  space:  { xs: 6, sm: 10, md: 14, lg: 20, xl: 28 },
  shadow: Platform.select({
    web: { boxShadow: "0 10px 24px rgba(16,42,67,0.10), 0 2px 6px rgba(16,42,67,0.06)" } as any,
    default: {},
  }),
};

/** ---- Card ---- */
export const Card: React.FC<{ title?: string; right?: React.ReactNode; style?: any; children?: any; }> = ({ title, right, style, children }) => (
  <View style={[styles.card, style]}>
    {title ? (
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>{right}</View>
      </View>
    ) : null}
    {children}
  </View>
);

/** ---- Button ---- */
export const Button: React.FC<{ variant?: "solid"|"ghost"|"danger"; icon?: keyof typeof Ionicons.glyphMap; onPress?: ()=>void; children?: any; disabled?: boolean; }> = ({ variant="solid", icon, onPress, children, disabled }) => {
  const v = variant === "danger" ? [styles.btn, styles.btnDanger] :
            variant === "ghost"  ? [styles.btnGhost] : [styles.btn];
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={v}>
      {icon ? <Ionicons name={icon} size={16} color={variant==="ghost" ? tokens.color.ink : "#fff"} style={{ marginRight: 6 }} /> : null}
      <Text style={variant==="ghost" ? styles.btnGhostText : styles.btnText}>{children}</Text>
    </TouchableOpacity>
  );
};

/** ---- Input with icon ---- */
export const Input: React.FC<{ icon?: keyof typeof Ionicons.glyphMap; placeholder?: string; value?: string; onChangeText?: (t:string)=>void; keyboardType?: any; secureTextEntry?: boolean; style?: any; }> = (p) => (
  <View style={[styles.inputWrap, p.style]}>
    {p.icon ? <Ionicons name={p.icon} size={16} color={tokens.color.inkMuted} style={{ marginRight: 8 }} /> : null}
    <TextInput
      placeholder={p.placeholder}
      placeholderTextColor={tokens.color.inkMuted}
      value={p.value}
      onChangeText={p.onChangeText}
      keyboardType={p.keyboardType}
      secureTextEntry={p.secureTextEntry}
      style={styles.input}
    />
  </View>
);

/** ---- Chip (filter/sort) ---- */
export const Chip: React.FC<{ label: string; active?: boolean; onPress?: ()=>void; }> = ({ label, active, onPress }) => (
  <TouchableOpacity onPress={onPress} style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}>
    <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextIdle]}>{label}</Text>
  </TouchableOpacity>
);

/** ---- Modal Sheet ---- */
export const ModalSheet: React.FC<{ visible: boolean; title: string; onClose: ()=>void; children?: any; footer?: any; }> = ({ visible, title, onClose, children, footer }) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.overlay}>
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Text numberOfLines={1} style={styles.sheetTitle}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeX}>
            <Ionicons name="close" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.sheetBody}>{children}</View>
        {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
      </View>
    </View>
  </Modal>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.color.card,
    borderRadius: tokens.radius.md,
    padding: tokens.space.md,
    ...tokens.shadow,
    borderWidth: 1,
    borderColor: tokens.color.line,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: tokens.space.md,
    justifyContent: "space-between",
  },
  cardTitle: { fontSize: 18, fontWeight: "700", color: tokens.color.ink },

  btn: {
    backgroundColor: tokens.color.brand,
    borderRadius: tokens.radius.sm,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  btnDanger: { backgroundColor: tokens.color.danger },
  btnText: { color: "#fff", fontWeight: "700" },

  btnGhost: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: tokens.color.line,
    borderRadius: tokens.radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  btnGhostText: { color: tokens.color.ink, fontWeight: "600" },

  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 10,
    height: 42,
    borderWidth: 1,
    borderColor: tokens.color.line,
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    color: tokens.color.ink,
    paddingVertical: 8,
    fontSize: 14,
  },

  chip: {
    borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12,
    borderWidth: 1, marginRight: 8, marginBottom: 8,
  },
  chipIdle:  { backgroundColor: "#fff", borderColor: tokens.color.line },
  chipActive:{ backgroundColor: tokens.color.chipBg, borderColor: tokens.color.brand },
  chipText:  { fontSize: 12 },
  chipTextIdle: { color: tokens.color.inkMuted, fontWeight: "600" },
  chipTextActive: { color: tokens.color.brand, fontWeight: "800" },

  overlay: { flex:1, backgroundColor:"rgba(16,42,67,0.45)", alignItems:"center", justifyContent:"center", padding:16 },
  sheet:   { width:"100%", maxWidth: 920, borderRadius: tokens.radius.lg, overflow:"hidden", ...tokens.shadow },
  sheetHeader: { backgroundColor: tokens.color.brand, padding: 14, paddingRight: 44 },
  sheetTitle:  { color:"#fff", fontWeight:"800", fontSize:16 },
  closeX: { position: "absolute", right: 10, top: 10, padding: 8, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  sheetBody:  { backgroundColor: "#fff", padding: 14, maxHeight: 560 },
  sheetFooter:{ backgroundColor: "#fff", padding: 12, borderTopWidth: 1, borderTopColor: tokens.color.line, flexDirection:"row", justifyContent:"flex-end", gap: 10 },
});