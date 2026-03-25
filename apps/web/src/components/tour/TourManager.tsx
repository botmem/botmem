import { useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useTourStore } from '../../store/tourStore';
import { tourSteps } from './tourSteps';
import './tour.css';

export function TourManager() {
  const { active, currentStep, completeTour, skipTour } = useTourStore();
  const navigate = useNavigate();
  const location = useLocation();
  const driverRef = useRef<Driver | null>(null);
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
        const driveStep: DriveStep = {
          element: step.target,
          popover: {
            title: step.title,
            description: step.description,
          },
        };

        // Interactive steps: allow user to interact with highlighted element
        if (step.interactable) {
          driveStep.disableActiveInteraction = false;
        }

        // Steps with search examples: inject "Try it" button via onPopoverRender
        if (step.searchExample) {
          const searchQuery = step.searchExample;
          driveStep.popover!.onPopoverRender = (popover) => {
            const tryBtn = document.createElement('button');
            tryBtn.className = 'botmem-tour-try-btn';
            tryBtn.textContent = `Try: "${searchQuery}"`;
            tryBtn.onclick = () => {
              const input = document.querySelector(
                '[data-tour="search-bar"] input',
              ) as HTMLInputElement;
              if (input) {
                // Use native setter to trigger React's onChange
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  HTMLInputElement.prototype,
                  'value',
                )?.set;
                nativeSetter?.call(input, searchQuery);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
              }
            };
            popover.description.appendChild(tryBtn);
          };
        }

        steps.push(driveStep);
      }

      const d = driver({
        showProgress: true,
        showButtons: ['next', 'previous', 'close'],
        steps,
        popoverClass: 'botmem-tour-popover',
        allowKeyboardControl: true,
        smoothScroll: true,
        stagePadding: 8,
        popoverOffset: 12,
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
            // Tour complete
            cleanup();
            completeTour();
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

      // Wait for elements to render (5s timeout for slow connections)
      const waitAndStart = () => {
        const step = tourSteps[fromStep];
        if (step.target) {
          const el = document.querySelector(step.target);
          if (!el) {
            // Poll for element (max 5 seconds)
            let tries = 0;
            const interval = setInterval(() => {
              tries++;
              const found = document.querySelector(step.target);
              if (found || tries > 50) {
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
    [cleanup, navigate, location.pathname, skipTour, completeTour],
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

  return null;
}
