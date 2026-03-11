import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useTourStore } from '../../store/tourStore';
import { tourSteps } from './tourSteps';
import { ConnectionInstructions } from './ConnectionInstructions';
import { SubscribeCTA } from './SubscribeCTA';
import './tour.css';

export function TourManager() {
  const { active, currentStep, completeTour, skipTour } = useTourStore();
  const navigate = useNavigate();
  const location = useLocation();
  const driverRef = useRef<Driver | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showSubscribeCTA, setShowSubscribeCTA] = useState(false);
  const navigatingRef = useRef(false);

  const cleanup = useCallback(() => {
    if (driverRef.current) {
      driverRef.current.destroy();
      driverRef.current = null;
    }
  }, []);

  const startDriver = useCallback(
    (fromStep: number) => {
      cleanup();

      // Build driver steps from current step onward
      const steps: DriveStep[] = [];
      for (let i = fromStep; i < tourSteps.length; i++) {
        const step = tourSteps[i];
        if (i === tourSteps.length - 1) {
          // Last step — connection instructions (modal, not a DOM target)
          steps.push({
            popover: {
              title: step.title,
              description: step.description + '\n\nClick "Done" to see setup instructions.',
            },
          });
        } else {
          steps.push({
            element: step.target,
            popover: {
              title: step.title,
              description: step.description,
            },
          });
        }
      }

      const d = driver({
        showProgress: true,
        showButtons: ['next', 'previous', 'close'],
        steps,
        popoverClass: 'botmem-tour-popover',
        onDestroyStarted: () => {
          if (!navigatingRef.current) {
            skipTour();
          }
          cleanup();
        },
        onNextClick: () => {
          const realStep = fromStep + (d.getActiveIndex() ?? 0);
          const nextRealStep = realStep + 1;

          if (nextRealStep >= tourSteps.length) {
            // Tour complete — show connection modal
            cleanup();
            setShowConnectModal(true);
            return;
          }

          const nextTourStep = tourSteps[nextRealStep];
          if (nextTourStep.page && nextTourStep.page !== location.pathname) {
            // Need to navigate to a different page
            navigatingRef.current = true;
            cleanup();
            useTourStore.setState({ currentStep: nextRealStep });
            navigate(nextTourStep.page);
            return;
          }

          d.moveNext();
        },
        onPrevClick: () => {
          const realStep = fromStep + (d.getActiveIndex() ?? 0);
          const prevRealStep = realStep - 1;

          if (prevRealStep < 0) return;

          const prevTourStep = tourSteps[prevRealStep];
          if (prevTourStep.page && prevTourStep.page !== location.pathname) {
            navigatingRef.current = true;
            cleanup();
            useTourStore.setState({ currentStep: prevRealStep });
            navigate(prevTourStep.page);
            return;
          }

          d.movePrevious();
        },
      });

      // Wait for elements to render
      const waitAndStart = () => {
        const step = tourSteps[fromStep];
        if (step.target) {
          const el = document.querySelector(step.target);
          if (!el) {
            // Poll for element (max 2 seconds)
            let tries = 0;
            const interval = setInterval(() => {
              tries++;
              const found = document.querySelector(step.target);
              if (found || tries > 20) {
                clearInterval(interval);
                navigatingRef.current = false;
                d.drive();
                driverRef.current = d;
              }
            }, 100);
            return;
          }
        }
        navigatingRef.current = false;
        d.drive();
        driverRef.current = d;
      };

      // Small delay to let page render
      requestAnimationFrame(() => {
        requestAnimationFrame(waitAndStart);
      });
    },
    [cleanup, navigate, location.pathname, skipTour],
  );

  // Start/resume tour when active changes or page navigates
  useEffect(() => {
    if (!active) {
      cleanup();
      return;
    }

    // Check if we're on the right page for the current step
    const step = tourSteps[currentStep];
    if (step && step.page && step.page !== location.pathname) {
      navigate(step.page);
      return;
    }

    // Start driver from current step
    startDriver(currentStep);

    return cleanup;
  }, [active, currentStep, location.pathname]);

  const handleConnectClose = () => {
    setShowConnectModal(false);
    completeTour();
    setShowSubscribeCTA(true);
  };

  const handleSubscribeClose = () => {
    setShowSubscribeCTA(false);
  };

  return (
    <>
      <ConnectionInstructions open={showConnectModal} onClose={handleConnectClose} />
      <SubscribeCTA open={showSubscribeCTA} onClose={handleSubscribeClose} />
    </>
  );
}
