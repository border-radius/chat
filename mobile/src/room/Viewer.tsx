// The image viewer (web views/room/viewer.ts, §17.7): full screen, swipe through the room's images and videos (and play
// audio), oldest first. It starts with those in the message window and fetches more as you get near either end.

import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, StatusBar, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { attachmentName, formatFull, isAudio, isVideo, type Message, parsePb } from "../shared";
import { IconButton, styles } from "../ui/components";
import { openFile } from "./open";

export interface Media {
  message: Message;
  file: string;
}

export interface ViewerProps {
  items: Media[];
  start: number;
  /** More before the first / after the last. */
  more: [boolean, boolean];
  /** The next page of media before (`back`) or after `edge`. */
  page: (back: boolean, edge: Message) => Promise<{ media: Media[]; done: boolean }>;
  fileUrl: (m: Message, file: string, thumb?: string) => string;
  refreshFileToken: () => Promise<unknown>;
  onClose: () => void;
}

const keyOf = (i: Media) => `${i.message.id}/${i.file}`;

export function Viewer(props: ViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState(props.items);
  const [index, setIndex] = useState(props.start);
  const [more, setMore] = useState(props.more);
  const loading = useRef({ back: false, forward: false });
  const list = useRef<FlatList<Media>>(null);
  const current = items[index];

  async function extend(back: boolean) {
    const side = back ? "back" : "forward";
    if (loading.current[side] || !more[back ? 0 : 1]) return;
    const edge = back ? items[0] : items.at(-1);
    if (!edge) return;
    loading.current[side] = true;
    try {
      const { media, done } = await props.page(back, edge.message);
      const known = new Set(items.map(keyOf));
      const fresh = media.filter((m) => !known.has(keyOf(m)));
      setMore((m) => (back ? [!done, m[1]] : [m[0], !done]));
      if (!fresh.length) return;
      if (back) {
        setItems((xs) => [...fresh, ...xs]);
        setIndex((i) => i + fresh.length);
        // Stay on the same picture: everything before it moved along.
        requestAnimationFrame(() => list.current?.scrollToIndex({ index: index + fresh.length, animated: false }));
      } else setItems((xs) => [...xs, ...fresh]);
    } catch {
      // offline: try again when swiped near the end again
    } finally {
      loading.current[side] = false;
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch when the position or the list changes
  useEffect(() => {
    if (index < 3) void extend(true);
    if (index > items.length - 4) void extend(false);
  }, [index, items.length]);

  return (
    <Modal visible animationType="none" onRequestClose={props.onClose} statusBarTranslucent navigationBarTranslucent>
      <StatusBar barStyle="light-content" />
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <FlatList
          ref={list}
          data={items}
          horizontal
          pagingEnabled
          initialScrollIndex={props.start}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={keyOf}
          showsHorizontalScrollIndicator={false}
          onScroll={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i !== index && i >= 0 && i < items.length) setIndex(i);
          }}
          scrollEventThrottle={100}
          renderItem={({ item, index: i }) => (
            <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
              {isVideo(item.file) || isAudio(item.file) ? (
                i === index ? (
                  <Player url={props.fileUrl(item.message, item.file)} audio={isAudio(item.file)} />
                ) : (
                  <Text style={{ color: "#fff", fontSize: 48 }}>▶</Text>
                )
              ) : (
                <Picture
                  uri={props.fileUrl(item.message, item.file)}
                  refresh={props.refreshFileToken}
                  retry={() => props.fileUrl(item.message, item.file)}
                />
              )}
            </View>
          )}
        />
        <View
          style={[
            styles.row,
            {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              paddingTop: insets.top + 6,
              paddingHorizontal: 8,
              gap: 8,
              backgroundColor: "rgba(0,0,0,0.45)",
            },
          ]}
        >
          <IconButton icon="×" label="Close" onPress={props.onClose} color="#fff" />
          <View style={{ flex: 1, paddingVertical: 6 }}>
            <Text style={{ color: "#fff", fontWeight: "700" }} numberOfLines={1}>
              {current ? attachmentName(current.message, current.file) : ""}
            </Text>
            <Text style={{ color: "#ddd", fontSize: 12 }} numberOfLines={1}>
              {current ? `${current.message.expand?.author?.name ?? ""} · ${formatFull(parsePb(current.message.created))}` : ""}
            </Text>
          </View>
          {current ? (
            <IconButton
              icon="⇩"
              label="Save or share"
              color="#fff"
              onPress={() =>
                void openFile(props.fileUrl(current.message, current.file), attachmentName(current.message, current.file)).catch(() => {})
              }
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/** An image, fitted to the screen. A failed load gets a fresh file token once (it may have expired, §17.3). */
function Picture({ uri, refresh, retry }: { uri: string; refresh: () => Promise<unknown>; retry: () => string }) {
  const [src, setSrc] = useState(uri);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const retried = useRef(false);
  if (failed) return <Text style={{ color: "#fff" }}>Couldn't load this image.</Text>;
  return (
    <>
      <Image
        source={{ uri: src }}
        style={{ width: "100%", height: "100%" }}
        contentFit="contain"
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (retried.current) return setFailed(true);
          retried.current = true;
          void refresh().then(
            () => setSrc(retry()),
            () => setFailed(true),
          );
        }}
      />
      {!loaded ? <ActivityIndicator style={{ position: "absolute" }} color="#fff" /> : null}
    </>
  );
}

/** A video (or an audio file), playing with the system's controls. */
function Player({ url, audio }: { url: string; audio: boolean }) {
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });
  return (
    <View style={{ width: "100%", height: audio ? 160 : "100%", justifyContent: "center" }}>
      {audio ? <Text style={{ color: "#fff", fontSize: 48, textAlign: "center" }}>♪</Text> : null}
      <VideoView player={player} style={{ width: "100%", height: audio ? 80 : "100%" }} nativeControls contentFit="contain" />
    </View>
  );
}
