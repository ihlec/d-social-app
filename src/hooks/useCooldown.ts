import { useState, useEffect } from 'react';

export const useCooldown = (lastActionTimestamp: number | undefined, cooldownDurationMs: number) => {
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!lastActionTimestamp) {
      setIsCoolingDown(false);
      setCountdown(0);
      return;
    }

    let intervalId: number | undefined;
    const checkCooldown = () => {
      const now = Date.now();
      const timeSinceLastAction = now - lastActionTimestamp;
      const remainingCooldown = cooldownDurationMs - timeSinceLastAction;

      if (remainingCooldown > 0) {
        setIsCoolingDown(true);
        setCountdown(Math.ceil(remainingCooldown / 1000));

        if (!intervalId) {
            intervalId = window.setInterval(() => {
                 const currentNow = Date.now();
                 const currentRemaining = cooldownDurationMs - (currentNow - lastActionTimestamp);
                if (currentRemaining <= 0) {
                     clearInterval(intervalId);
                     intervalId = undefined;
                    setIsCoolingDown(false);
                    setCountdown(0);
                } else {
                    setCountdown(Math.ceil(currentRemaining / 1000));
                }
            }, 1000);
        }

      } else {
        setIsCoolingDown(false);
        setCountdown(0);
        if (intervalId) {
             clearInterval(intervalId);
             intervalId = undefined;
        }
      }
    };

    checkCooldown(); 

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [lastActionTimestamp, cooldownDurationMs]);

  return { isCoolingDown, countdown };
};