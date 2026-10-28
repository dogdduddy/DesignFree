import {
  createNode,
  type SceneDocument,
  type SceneNode,
  type NodeType,
  type Paint,
} from "./index";
const pattern =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAErElEQVR4nBXOYQeGBgIA4PudxzjGOMY+jNncNE3TZJlOp9M0TZZpmqZpOtGHiIiIeH/B/Y275/3wfH/+8vlf//u/fxAQEhGTkJKRU1BSUdPQ0tEzMDIxs7CysXNwcnHz8OIvn38gQEBIRExCSkZOQUlFTUNLR8/AyMTMwsrGzsHJxc3D64N34G8CBIRExCSkZOQUlFTUNLR09AyMTMwsrGzsHJxc3Dy8/vYOfChAQEhETEJKRk5BSUVNQ0tHz8DIxMzCysbOwcnFzcPrw3fgIwECQiJiElIycgpKKmoaWjp6BkYmZhZWNnYOTi5uHl4fvQN/FyAgJCImISUjp6CkoqahpaNnYGRiZmFlY+fg5OLm4fX3d+BjAQJCImISUjJyCkoqahpaOnoGRiZmFlY2dg5OLm4eXh+/A58IEBASEZOQkpFTUFJR09DS0TMwMjGzsLKxc3BycfPw+uQd+FSAgJCImISUjJyCkoqahpaOnoGRiZmFlY2dg5OLm4fXp+/AZwIEhETEJKRk5BSUVNQ0tHT0DIxMzCysbOwcnFzcPLw+ewe+ECAgJCImISUjp6CkoqahpaNnYGRiZmFlY+fg5OLm4fXFO/ClAAEhETEJKRk5BSUVNQ0tHT0DIxMzCysbOwcnFzcPry/fga8ECAiJiElIycgpKKmoaWjp6BkYmZhZWNnYOTi5uHl4ffUOfC1AQEhETEJKRk5BSUVNQ0tHz8DIxMzCysbOwcnFzcPr63fgGwECQiJiElIycgpKKmoaWjp6BkYmZhZWNnYOTi5uHl7fvAPfChAQEhGTkJKRU1BSUdPQ0tEzMDIxs7CysXNwcnHz8Pr2HfhOgICQiJiElIycgpKKmoaWjp6BkYmZhZWNnYOTi5uH13fvwPcCBIRExCSkZOQUlFTUNLR09AyMTMwsrGzsHJxc3Dy8vn8H/ilAQEhETEJKRk5BSUVNQ0tHz8DIxMzCysbOwcnFzcPrn+/AvwQICImISUjJyCkoqahpaOnoGRiZmFlY2dg5OLm4eXj96x34twABIRExCSkZOQUlFTUNLR09AyMTMwsrGzsHJxc3D69/vwM/CBAQEhGTkJKRU1BSUdPQ0tEzMDIxs7CysXNwcnHz8PrhHfhRgICQiJiElIycgpKKmoaWjp6BkYmZhZWNnYOTi5uH14/vwE8CBIRExCSkZOQUlFTUNLR09AyMTMwsrGzsHJxc3Dy8fnoHfhYgICQiJiElI6egpKKmoaWjZ2BkYmZhZWPn4OTi5uH18zvwiwABIRExCSkZOQUlFTUNLR09AyMTMwsrGzsHJxc3D69f3oFfBQgIiYhJSMnIKSipqGlo6egZGJmYWVjZ2Dk4ubh5eP36DvwmQEBIRExCSkZOQUlFTUNLR8/AyMTMwsrGzsHJxc3D67d34HcBAkIiYhJSMnIKSipqGlo6egZGJmYWVjZ2Dk4ubh5ev78DfwgQEBIRk5CSkVNQUlHT0NLRMzAyMbOwsrFzcHJx8/D64x34U4CAkIiYhJSMnIKSipqGlo6egZGJmYWVjZ2Dk4ubh9ef78B/BAgIiYhJSMnIKSipqGlo6egZGJmYWVjZ2Dk4ubh5ePF/gaBctXyg8bAAAAAASUVORK5CYII=";
const solid = (color: string): Paint => ({ type: "solid", color });
const gradient: Paint = {
  type: "linear",
  from: [0, 0],
  to: [1, 1],
  stops: [
    { offset: 0, color: "#B2B2FF" },
    { offset: 1, color: "#F4C8AF" },
  ],
};
function blank(name: string): SceneDocument {
  const root = createNode("page", null, {
    id: "page",
    name: "Design space",
    width: 1040,
    height: 920,
    fill: { type: "none" },
  });
  return {
    schemaVersion: 1,
    id: "form-demo",
    name,
    rootId: root.id,
    nodes: { [root.id]: root },
    assets: {
      pattern: {
        id: "pattern",
        mimeType: "image/png",
        dataUrl: pattern,
        width: 32,
        height: 32,
      },
    },
  };
}
export function createDemoDocument(): SceneDocument {
  const d = blank("Morrow · a calmer everyday");
  let sequence = 0;
  function add(
    type: NodeType,
    parentId: string,
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fill: Paint,
    props: Partial<SceneNode> = {},
  ) {
    const n = createNode(type, parentId, {
      id: `demo-${++sequence}`,
      name,
      transform: [1, 0, 0, 1, x, y],
      width,
      height,
      fill,
      ...props,
    });
    d.nodes[n.id] = n;
    d.nodes[parentId].children.push(n.id);
    return n.id;
  }
  function txt(
    parent: string,
    content: string,
    x: number,
    y: number,
    size = 16,
    color = "#242236",
    weight = 400,
    width = 310,
    height = 40,
  ) {
    return add(
      "text",
      parent,
      content,
      x,
      y,
      width,
      height,
      { type: "none" },
      {
        text: {
          content,
          fontFamily: "Noto Sans KR",
          fontSize: size,
          fontWeight: weight,
          lineHeight: size * 1.45,
        },
        fill: solid(color),
      },
    );
  }
  const landing = add(
    "frame",
    "page",
    "01 · Welcome",
    120,
    90,
    360,
    700,
    solid("#F8F5F0"),
    { radius: 28, clipContent: true },
  );
  txt(landing, "morrow", 26, 23, 23, "#282438", 700);
  txt(landing, "○", 302, 24, 22, "#605A78", 400, 35);
  const art = add(
    "frame",
    landing,
    "A little room to breathe",
    22,
    86,
    316,
    278,
    gradient,
    { radius: 105, clipContent: true },
  );
  add("ellipse", art, "Sun", 162, 29, 110, 110, solid("#F7E1B5"));
  add("rectangle", art, "Quiet arch", 29, 111, 139, 215, solid("#646197"), {
    radius: 66,
    transform: [0.966, -0.259, 0.259, 0.966, 14, 124],
  });
  add("ellipse", art, "Orbital light", 131, 150, 156, 156, solid("#9B98D0"));
  add("ellipse", art, "Small moon", 99, 95, 55, 55, solid("#F9F5EC"));
  add(
    "image",
    art,
    "Original gradient tile",
    183,
    199,
    72,
    48,
    { type: "none" },
    {
      assetId: "pattern",
      radius: 12,
      transform: [0.94, 0.342, -0.342, 0.94, 197, 192],
    },
  );
  txt(landing, "MAKE SPACE FOR YOU", 26, 393, 10, "#78718D", 700);
  txt(
    landing,
    "A softer start.\nA brighter everyday.",
    26,
    421,
    28,
    "#282438",
    600,
    310,
    91,
  );
  txt(
    landing,
    "작은 쉼이 만드는 새로운 하루.\n나만의 속도로, 모로우와 함께.",
    26,
    524,
    13,
    "#797382",
    400,
    310,
    48,
  );
  add(
    "rectangle",
    landing,
    "Get started button",
    24,
    605,
    312,
    52,
    solid("#39324F"),
    { radius: 26 },
  );
  txt(landing, "나의 하루 시작하기   →", 48, 620, 14, "#FFFFFF", 500, 265, 25);
  const login = add(
    "frame",
    "page",
    "02 · Sign in",
    550,
    90,
    360,
    700,
    solid("#FFFFFF"),
    { radius: 28, clipContent: true },
  );
  txt(login, "←", 26, 24, 21, "#514B60");
  txt(login, "morrow", 137, 25, 19, "#282438", 700, 130);
  add("ellipse", login, "Welcome halo", 132, 103, 96, 96, solid("#F0EDF8"));
  add("ellipse", login, "Welcome spark", 155, 126, 50, 50, gradient);
  txt(login, "Welcome back.", 26, 227, 28, "#282438", 600);
  txt(login, "오늘도 당신을 위한 작은 공간.", 26, 277, 13, "#86808D");
  txt(login, "이메일", 26, 336, 11, "#6E687C", 500);
  add("rectangle", login, "Email field", 24, 360, 312, 49, solid("#F8F7FA"), {
    radius: 10,
    stroke: { color: "#ECE9F0", width: 1 },
  });
  txt(login, "hello@morrow.studio", 40, 375, 13, "#4C465F");
  txt(login, "비밀번호", 26, 432, 11, "#6E687C", 500);
  add(
    "rectangle",
    login,
    "Password field",
    24,
    456,
    312,
    49,
    solid("#F8F7FA"),
    { radius: 10, stroke: { color: "#ECE9F0", width: 1 } },
  );
  txt(login, "••••••••••", 40, 470, 15, "#4C465F");
  txt(login, "비밀번호를 잊으셨나요?", 193, 520, 10, "#8B829C", 400, 150, 23);
  add(
    "rectangle",
    login,
    "Sign in button",
    24,
    563,
    312,
    51,
    solid("#A89AC4"),
    { radius: 26 },
  );
  txt(login, "로그인하고 계속하기   →", 62, 578, 13, "#FFFFFF", 600, 270, 25);
  txt(
    login,
    "아직 계정이 없으신가요?  가입하기",
    62,
    643,
    11,
    "#8B829C",
    400,
    280,
  );
  return d;
}
/** Exact total node count INCLUDING the page root. Deterministic mixed render fixture. */
export function createBenchmarkDocument(count: number): SceneDocument {
  if (!Number.isInteger(count) || count < 1 || count > 100000)
    throw new Error("Count must be 1..100000");
  const d = blank(`Benchmark ${count} nodes`);
  d.id = `benchmark-${count}`;
  d.nodes.page.width = 1800;
  d.nodes.page.height = Math.max(1200, Math.ceil(count / 30) * 50);
  let group = "page";
  for (let i = 1; i < count; i++) {
    const isGroup = i % 25 === 1;
    const type: NodeType = isGroup
      ? "frame"
      : (["rectangle", "ellipse", "text", "image"] as const)[i % 4];
    const parent = isGroup ? "page" : group;
    const n = createNode(type, parent, {
      id: `bench-${i}`,
      name: `${type} ${i}`,
      width: isGroup ? 250 : type === "text" ? 95 : 35,
      height: isGroup ? 130 : 35,
      transform: [
        1,
        0,
        0,
        1,
        isGroup ? (i % 150) * 11 : (i % 5) * 44,
        isGroup ? Math.floor(i / 150) * 150 : Math.floor((i % 25) / 5) * 27,
      ],
      fill:
        i % 7 === 0
          ? gradient
          : solid(["#9F9DD7", "#E7B6A6", "#8ABDB0", "#D6BD7E"][i % 4]),
      radius: 6,
      clipContent: isGroup,
      stroke: { color: "#544875", width: 1 },
      ...(type === "image" ? { assetId: "pattern" } : {}),
      ...(type === "text"
        ? {
            text: {
              content: `Hello 안녕 ${i}`,
              fontFamily: "Noto Sans KR",
              fontSize: 12,
              fontWeight: 400,
              lineHeight: 18,
            },
          }
        : {}),
    });
    d.nodes[n.id] = n;
    d.nodes[parent].children.push(n.id);
    if (isGroup) group = n.id;
  }
  return d;
}
