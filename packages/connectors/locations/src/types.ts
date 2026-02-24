export interface OwnTracksLocation {
  /** Unix timestamp */
  tst: number;
  /** Latitude */
  lat: number;
  /** Longitude */
  lon: number;
  /** Accuracy in meters */
  acc?: number;
  /** Altitude */
  alt?: number;
  /** Velocity (km/h) */
  vel?: number;
  /** Course over ground (degrees) */
  cog?: number;
  /** Battery level (%) */
  batt?: number;
  /** Vertical accuracy */
  vac?: number;
  /** Tracker ID (2-char) */
  tid?: string;
  /** Reverse-geocoded address */
  addr?: string;
  /** Country code */
  cc?: string;
  /** Geohash */
  ghash?: string;
  /** ISO timestamp */
  isotst?: string;
  /** Display timestamp */
  disptst?: string;
}

export interface CursorState {
  /** Tracks last synced timestamp (unix) per user/device */
  pairs: Record<string, number>;
  /** Index of the next user/device pair to process */
  pairIndex: number;
}
