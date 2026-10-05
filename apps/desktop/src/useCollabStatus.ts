import { useEffect, useState } from "react";

import { DEFAULT_COLLAB_STATUS, type CollabStatus } from "./collabStatus";
import { getCollabStatus, onCollabStatus } from "./terminalApi";

/// Estado real de la status bar: pide el valor actual una vez y después escucha
/// los cambios que emite el núcleo. Mientras tanto (o si falla) muestra el
/// valor honesto por defecto.
export function useCollabStatus(): CollabStatus {
  const [status, setStatus] = useState<CollabStatus>(DEFAULT_COLLAB_STATUS);

  useEffect(() => {
    let active = true;
    // Un evento posterior a la consulta inicial manda sobre ella.
    let receivedEvent = false;
    const unlisten = onCollabStatus((next) => {
      receivedEvent = true;
      if (active) setStatus(next);
    });
    getCollabStatus()
      .then((initial) => {
        if (active && !receivedEvent) setStatus(initial);
      })
      .catch(() => {});
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return status;
}
