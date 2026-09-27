// The native rows: the same designs as web/src/rows.tsx + web/src/styles.ts, from the same
// numbers (../../shared/theme.ts). View / Text / Image only.

import { Image, StyleSheet, Text, View } from "react-native";
import type { ChatItem, HeaderItem, ImageItem, Item, RowItem, Span } from "../../shared/data.ts";
import { IMAGE_ASSETS } from "../../shared/data.ts";
import { CHAT, COLORS, FIXED, HEADER, IMAGE, MONO_FONT, PALETTE } from "../../shared/theme.ts";
import { IMAGES } from "./images";

const s = StyleSheet.create({
  fixed: {
    height: FIXED.height,
    flexDirection: "row",
    alignItems: "center",
    gap: FIXED.gap,
    paddingHorizontal: FIXED.padH,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  avatar: {
    width: FIXED.avatar,
    height: FIXED.avatar,
    borderRadius: FIXED.avatar / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: FIXED.avatarFont, fontWeight: "600" },
  fixedBody: { flex: 1, minWidth: 0 },
  title: {
    fontSize: FIXED.titleSize,
    lineHeight: FIXED.titleLine,
    fontWeight: "600",
    color: COLORS.text,
  },
  sub: { fontSize: FIXED.subSize, lineHeight: FIXED.subLine, color: COLORS.muted },
  time: { fontSize: FIXED.timeSize, lineHeight: FIXED.timeLine, color: COLORS.muted },
  header: {
    height: HEADER.height,
    paddingHorizontal: HEADER.padH,
    backgroundColor: COLORS.headerBg,
    justifyContent: "center",
  },
  headerText: {
    fontSize: HEADER.size,
    fontWeight: HEADER.weight,
    color: COLORS.headerText,
  },
  chat: { paddingVertical: CHAT.padV, paddingHorizontal: CHAT.padH, backgroundColor: COLORS.bg },
  chatBody: { gap: CHAT.paraGap },
  userBody: {
    marginLeft: CHAT.bubbleIndent,
    backgroundColor: COLORS.userBubble,
    borderRadius: CHAT.bubbleRadius,
    padding: CHAT.bubblePad,
  },
  role: {
    fontSize: CHAT.roleSize,
    lineHeight: CHAT.roleLine,
    fontWeight: "600",
    color: COLORS.muted,
  },
  p: { fontSize: CHAT.size, lineHeight: CHAT.line, color: COLORS.text },
  b: { fontWeight: "700" },
  a: { color: COLORS.link, textDecorationLine: "underline" },
  ic: {
    fontFamily: MONO_FONT,
    backgroundColor: COLORS.inlineCodeBg,
    fontSize: CHAT.codeSize + 1,
  },
  code: {
    backgroundColor: COLORS.codeBg,
    borderRadius: CHAT.codeRadius,
    padding: CHAT.codePad,
  },
  codeText: {
    fontFamily: MONO_FONT,
    fontSize: CHAT.codeSize,
    lineHeight: CHAT.codeLine,
    color: COLORS.codeText,
  },
  image: { paddingVertical: IMAGE.padV, paddingHorizontal: IMAGE.padH, backgroundColor: COLORS.bg },
  img: { width: "100%", borderRadius: IMAGE.radius },
  caption: {
    marginTop: IMAGE.captionGap,
    fontSize: IMAGE.captionSize,
    lineHeight: IMAGE.captionLine,
    color: COLORS.text,
  },
});

function FixedRow({ item }: { item: RowItem }) {
  return (
    <View style={s.fixed}>
      <View style={[s.avatar, { backgroundColor: PALETTE[item.color] }]}>
        <Text style={s.avatarText}>{item.initials}</Text>
      </View>
      <View style={s.fixedBody}>
        <Text style={s.title} numberOfLines={1}>{item.title}</Text>
        <Text style={s.sub} numberOfLines={1}>{item.subtitle}</Text>
      </View>
      <Text style={s.time}>{item.time}</Text>
    </View>
  );
}

export function HeaderRow({ item }: { item: HeaderItem }) {
  return (
    <View style={s.header}>
      <Text style={s.headerText}>{item.title} · {item.count}</Text>
    </View>
  );
}

function SpanView({ span }: { span: Span }) {
  if (span.bold) return <Text style={s.b}>{span.text}</Text>;
  if (span.href) return <Text style={s.a}>{span.text}</Text>;
  if (span.code) return <Text style={s.ic}>{span.text}</Text>;
  return <>{span.text}</>;
}

function ChatRow({ item }: { item: ChatItem }) {
  return (
    <View style={s.chat}>
      <View style={item.role === "user" ? [s.chatBody, s.userBody] : s.chatBody}>
        {item.role === "assistant" && <Text style={s.role}>Assistant</Text>}
        {item.blocks.map((b, i) =>
          b.type === "p"
            ? (
              <Text key={i} style={s.p}>
                {b.spans.map((sp, j) => <SpanView key={j} span={sp} />)}
              </Text>
            )
            : (
              <View key={i} style={s.code}>
                <Text style={s.codeText}>{b.lines.join("\n")}</Text>
              </View>
            )
        )}
      </View>
    </View>
  );
}

function ImageRow({ item }: { item: ImageItem }) {
  const img = IMAGE_ASSETS[item.image];
  return (
    <View style={s.image}>
      <Image
        source={IMAGES[item.image]}
        style={[s.img, { aspectRatio: img.w / img.h, backgroundColor: PALETTE[item.image % 10] }]}
        resizeMode="cover"
      />
      <Text style={s.caption}>{item.caption}</Text>
    </View>
  );
}

/** One item's content, whatever its kind (not memoized: the web rows are not either). */
export function ItemView({ item }: { item: Item }) {
  switch (item.type) {
    case "row":
      return <FixedRow item={item} />;
    case "header":
      return <HeaderRow item={item} />;
    case "chat":
      return <ChatRow item={item} />;
    case "image":
      return <ImageRow item={item} />;
  }
}
