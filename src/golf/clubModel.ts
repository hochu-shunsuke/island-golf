import * as THREE from 'three';
import { PUTTER } from './clubs';

/**
 * 球の所に構えたクラブ（みんゴルのキャラクターが持っているクラブの代わり）。今どのクラブで打つかが一目で分かる。
 * 球と同じく見やすい大きさにしてある（球は本物の約 5 倍）。右打ちの人が後ろから見て球の左に立つ向き。
 * group の -z が打つ向き、+x が右。
 */

const SHAFT = new THREE.MeshLambertMaterial({ color: 0xc9ced3 });
const GRIP = new THREE.MeshLambertMaterial({ color: 0x1e2226 });
const WOOD = new THREE.MeshLambertMaterial({ color: 0x23324a });
const IRON = new THREE.MeshLambertMaterial({ color: 0xd8dde2 });
const PUTTER_HEAD = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });

type Kind = 'wood' | 'iron' | 'putter';

function kindOf(club: number): Kind {
  if (club === PUTTER) return 'putter';
  return club <= 1 ? 'wood' : 'iron';
}

/** ヘッドの真ん中（球のすぐ後ろ）から手元へ伸びるシャフトを、向きを合わせて置く。 */
function shaftBetween(from: THREE.Vector3, to: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const d = to.clone().sub(from);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.15, d.length(), 10), mat);
  mesh.position.copy(from).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return mesh;
}

function build(kind: Kind): THREE.Group {
  const g = new THREE.Group();
  // ヘッドの真ん中は球の後ろ（+z）。パターは短く、手元が低い。
  const head = new THREE.Vector3(0, kind === 'wood' ? 0.07 : 0.05, 0.17);
  const hands = kind === 'putter' ? new THREE.Vector3(-0.35, 0.85, 0.22) : new THREE.Vector3(-0.72, 0.95, 0.24);
  const heel = head.clone().add(new THREE.Vector3(-0.09, 0.03, 0));
  const gripFrom = heel.clone().lerp(hands, 0.8);
  g.add(shaftBetween(heel, gripFrom, 0.012, SHAFT));
  g.add(shaftBetween(gripFrom, hands, 0.02, GRIP));
  let mesh: THREE.Mesh;
  if (kind === 'wood') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 12), WOOD);
    mesh.scale.set(1.25, 0.6, 1.0);
  } else if (kind === 'iron') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.1, 0.035), IRON);
    mesh.rotation.x = -0.35; // ロフト（フェースが少し上を向く）。
  } else {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.07), PUTTER_HEAD);
  }
  mesh.position.copy(head);
  g.add(mesh);
  return g;
}

export class ClubModel {
  readonly group = new THREE.Group();
  private readonly kinds = new Map<Kind, THREE.Group>();
  private shown: Kind | null = null;

  /** 球の位置 (x, y, z)（球の中心）・打つ向き yaw・クラブの番号。visible が false なら隠す。 */
  update(visible: boolean, x: number, y: number, z: number, yaw: number, club: number, ballRadius: number): void {
    this.group.visible = visible;
    if (!visible) return;
    const kind = kindOf(club);
    if (this.shown !== kind) {
      if (this.shown) this.kinds.get(this.shown)!.visible = false;
      let g = this.kinds.get(kind);
      if (!g) {
        g = build(kind);
        this.kinds.set(kind, g);
        this.group.add(g);
      }
      g.visible = true;
      this.shown = kind;
    }
    this.group.position.set(x, y - ballRadius, z);
    this.group.rotation.y = yaw;
  }
}
