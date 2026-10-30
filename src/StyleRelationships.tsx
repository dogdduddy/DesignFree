import type { SceneDocument } from "./core";
import {
  inspectStyleRelationships,
  type StyleRelationship,
} from "./style-library-inspection";
import type { StyleLibrary } from "./style-library";
export function StyleRelationships({
  document: doc,
  library,
}: {
  document: SceneDocument;
  library: StyleLibrary;
}) {
  const relations = inspectStyleRelationships(doc, library);
  const source = (nodeId: string, kind: string) => {
    for (const n of Object.values(doc.nodes)) {
      if (n.component?.kind !== "instance") continue;
      const sourceId = Object.entries(n.component.nodeMap).find(
        ([, id]) => id === nodeId,
      )?.[0];
      if (sourceId)
        return `원본 ${doc.nodes[sourceId]?.name ?? sourceId} (${sourceId}) · ${Object.keys(n.component.overrides[sourceId] ?? {}).some((p) => (p === "styleRefs" ? Object.hasOwn(n.component?.kind === "instance" ? (n.component.overrides[sourceId]?.[p] ?? {}) : {}, kind) : p === `styleRefs.${kind}`)) ? "스타일 override" : "스타일 상속"}`;
    }
    return doc.nodes[nodeId]?.component?.kind === "main"
      ? "컴포넌트 원본"
      : "레이어 직접 연결";
  };
  const row = (entry: StyleRelationship, group: string) => (
    <details key={entry.id} data-testid={`style-relation-${entry.id}`}>
      <summary>
        {entry.name} · {group} · 연결{" "}
        {new Set(entry.linkedLayers.map((l) => l.nodeId)).size}개
      </summary>
      <p>
        {group}.{entry.id}
      </p>
      {entry.chains.map((chain, i) => (
        <p key={i}>
          {chain.theme
            ? `테마 ${library.themes[chain.theme]?.name ?? chain.theme}`
            : "기본 상속"}
          : {chain.paths.join(" → ")}
          {chain.error
            ? ` · ${chain.error}`
            : ` → ${JSON.stringify(chain.value)}`}
        </p>
      ))}
      {entry.linkedLayers.length === 0 ? (
        <p>연결된 레이어 없음</p>
      ) : (
        <ul>
          {entry.linkedLayers.map((link) => (
            <li key={link.path}>
              {link.nodeName} ({link.nodeId}) ·{" "}
              {link.source === "variantOverride"
                ? "보존된 variant override"
                : source(
                    link.nodeId,
                    link.path.split(".").at(-1) ?? entry.kind,
                  )}
              <br />
              {link.path}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
  return (
    <details className="style-relationships" data-testid="style-relationships">
      <summary>상속 관계 · 연결된 레이어 영향</summary>
      <p>
        모든 테마에서 참조 경로에 포함되는 레이어와 보존된 override입니다.
        테마/기본 경로와 최종 값을 비교하세요. 잠긴 레이어도 공통 스타일 변경의
        영향을 받습니다.
      </p>
      {relations.tokens.map((r) => row(r, "tokens"))}
      {relations.styles.map((r) => row(r, "styles"))}
    </details>
  );
}
