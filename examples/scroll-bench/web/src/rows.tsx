// The row components every web impl renders (plain DOM + the classes in styles.ts), so the
// impls differ only in how they virtualize, never in what a row costs to draw.

import type { ChatItem, HeaderItem, ImageItem, Item, RowItem, Span } from "../../shared/data.ts";
import { IMAGE_ASSETS } from "../../shared/data.ts";
import type { JSX } from "denext";
import { PALETTE } from "../../shared/theme.ts";

function FixedRow({ item }: { item: RowItem }) {
  return (
    <div className="sb-fixed">
      <div className="sb-avatar" style={{ background: PALETTE[item.color] }}>
        {item.initials}
      </div>
      <div className="sb-fixed-body">
        <div className="sb-title">{item.title}</div>
        <div className="sb-sub">{item.subtitle}</div>
      </div>
      <div className="sb-time">{item.time}</div>
    </div>
  );
}

function HeaderRow({ item }: { item: HeaderItem }) {
  return <div className="sb-header">{item.title} · {item.count}</div>;
}

function SpanView({ span }: { span: Span }) {
  if (span.bold) return <b className="sb-b">{span.text}</b>;
  if (span.href) return <a className="sb-a" href={span.href}>{span.text}</a>;
  if (span.code) return <code className="sb-ic">{span.text}</code>;
  return <>{span.text}</>;
}

function ChatRow({ item }: { item: ChatItem }) {
  return (
    <div className={`sb-chat ${item.role}`}>
      <div className="sb-chat-body">
        {item.role === "assistant" && <div className="sb-role">Assistant</div>}
        {item.blocks.map((b, i) =>
          b.type === "p"
            ? (
              <p key={i} className="sb-p">
                {b.spans.map((s, j) => <SpanView key={j} span={s} />)}
              </p>
            )
            : <pre key={i} className="sb-code">{b.lines.join("\n")}</pre>
        )}
      </div>
    </div>
  );
}

function ImageRow({ item }: { item: ImageItem }) {
  const img = IMAGE_ASSETS[item.image];
  return (
    <div className="sb-image">
      <img
        className="sb-img"
        src={`/img/${img.file}`}
        width={img.w}
        height={img.h}
        style={{
          aspectRatio: `${img.w} / ${img.h}`,
          background: PALETTE[item.image % 10],
        }}
        decoding="async"
        alt=""
      />
      <p className="sb-caption">{item.caption}</p>
    </div>
  );
}

const VIEWS: { [K in Item["type"]]: (p: { item: Extract<Item, { type: K }> }) => JSX.Element } = {
  row: FixedRow,
  header: HeaderRow,
  chat: ChatRow,
  image: ImageRow,
};

/** One item's content, whatever its kind. Every impl wraps it in its own positioned cell. */
export function ItemView({ item }: { item: Item }) {
  const View = VIEWS[item.type] as (p: { item: Item }) => JSX.Element;
  return <View item={item} />;
}
