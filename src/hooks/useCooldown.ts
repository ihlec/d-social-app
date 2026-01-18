import { useState, useEffect, useRef } from 'react';

export const useCooldown = (lastActionTimestamp: number | undefined, cooldownDurationMs: number) => {
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const intervalIdRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!lastActionTimestamp) {
      setIsCoolingDown(false);
      setCountdown(0);
      // Clear any existing interval
      if (intervalIdRef.current !== undefined) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = undefined;
      }
      return;
    }

    const checkCooldown = () => {
      const now = Date.now();
      const timeSinceLastAction = now - lastActionTimestamp;
      const remainingCooldown = cooldownDurationMs - timeSinceLastAction;

      if (remainingCooldown > 0) {
        setIsCoolingDown(true);
        setCountdown(Math.ceil(remainingCooldown / 1000));

        // Clear any existing interval before creating a new one
        if (intervalIdRef.current !== undefined) {
          clearInterval(intervalIdRef.current);
        }

        intervalIdRef.current = window.setInterval(() => {
          const currentNow = Date.now();
          const currentRemaining = cooldownDurationMs - (currentNow - lastActionTimestamp);
          if (currentRemaining <= 0) {
            if (intervalIdRef.current !== undefined) {
              clearInterval(intervalIdRef.current);
              intervalIdRef.current = undefined;
            }
            setIsCoolingDown(false);
            setCountdown(0);
          } else {
            setCountdown(Math.ceil(currentRemaining / 1000));
          }
        }, 1000);

      } else {
        setIsCoolingDown(false);
        setCountdown(0);
        if (intervalIdRef.current !== undefined) {
          clearInterval(intervalIdRef.current);
          intervalIdRef.current = undefined;
        }
      }
    };

    checkCooldown(); 

    return () => {
      if (intervalIdRef.current !== undefined) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = undefined;
      }
    };
  }, [lastActionTimestamp, cooldownDurationMs]);

  return { isCoolingDown, countdown };
};