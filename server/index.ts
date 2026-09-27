import { isRoomId } from '../shared/room';
import { GolfRoom } from './room';

export { GolfRoom };

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

/**
 * 配信と中継を 1 つの Worker で（stroll と同じ）。ビルドしたゲームの静的ファイルは配信側が先に返し、
 * ここへ来るのは部屋への接続（/ws）と、打ち間違いのパスだけ。
 * コースの合言葉は URL の # に載るのでサーバには届かない。部屋の番号だけを /ws?room= で受け取る。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room');
      // 決まりに合わない番号では部屋を作らせない（好き勝手な名前の部屋がいくらでも生えないように）。
      if (!isRoomId(room)) return new Response('invalid room', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }
    // 打ち間違いのパスでも 404 にせず、ゲームを見せる（合言葉は # に載っているので、そのまま正しいコースになる）。
    return env.ASSETS.fetch(new Request(new URL('/', url), request));
  },
};
