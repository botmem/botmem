import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, SPRING_SNAPPY } from '../theme';
import { displayFont } from '../fonts';
import { ChatBubble } from '../components/ChatBubble';
import { ChatTopbar } from '../components/ChatTopbar';
import { ChatInput } from '../components/ChatInput';
import { TypeWriter } from '../components/TypeWriter';
import { Badge } from '../components/Badge';
import { ToolCallCard } from '../components/ToolCallCard';
import { MemoryCard } from '../components/MemoryCard';

const C = 2; // frames per character

// --- CONVERSATION TIMELINE ---
const USER1 = 'I just took Nugget 🐕 to the vet. Can you file an insurance claim for me?';
const U1_START = 0;
const U1_END = U1_START + USER1.length * C;

const TC1_START = U1_END + 12;
const TC1_DELAY = 30;

const AI1 =
  'Found it — you have a PetInsure policy covering vet visits up to AED 7,500. Let me pull the vet report.';
const A1_START = TC1_START + TC1_DELAY + 20;
const A1_END = A1_START + AI1.length * C;

const TC2_START = A1_END + 10;
const TC2_DELAY = 28;

const AI2 =
  "Got the report from Dr. Martinez — Nugget 🐕's checkup from yesterday. Now drafting the claim email.";
const A2_START = TC2_START + TC2_DELAY + 18;
const A2_END = A2_START + AI2.length * C;

const TC3_START = A2_END + 10;
const TC3_DELAY = 25;

const AI3 =
  'Done! Sent the claim to claims@petinsure.com with your policy details, vet report, and invoice attached.';
const A3_START = TC3_START + TC3_DELAY + 18;
const A3_END = A3_START + AI3.length * C;

const BADGES_START = A3_END + 15;

const GAP = 20;

export const MagicScene: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Badge springs
  const b1 = spring({ frame: Math.max(0, frame - BADGES_START), fps, config: SPRING_SNAPPY });
  const b2 = spring({ frame: Math.max(0, frame - BADGES_START - 6), fps, config: SPRING_SNAPPY });
  const b3 = spring({ frame: Math.max(0, frame - BADGES_START - 12), fps, config: SPRING_SNAPPY });

  // Memory cards appear when tool calls return results
  const mc1Start = TC1_START + TC1_DELAY;
  const mc2Start = TC2_START + TC2_DELAY;
  const mc1Scale = spring({ frame: Math.max(0, frame - mc1Start), fps, config: SPRING_SNAPPY });
  const mc2Scale = spring({ frame: Math.max(0, frame - mc2Start), fps, config: SPRING_SNAPPY });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      {/* Topbar */}
      <ChatTopbar hasBotmem />

      {/* Chat area — bottom-anchored, messages grow upward */}
      <div
        style={{
          position: 'absolute',
          top: 68,
          left: 0,
          right: 420,
          bottom: 74,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: GAP,
            padding: '24px 60px 24px 60px',
          }}
        >
          {/* User message — reserve full height to prevent jitter */}
          {frame >= U1_START && (
            <div style={{ minHeight: 120 }}>
              <ChatBubble variant="user">
                <TypeWriter text={USER1} charFrames={C} />
              </ChatBubble>
            </div>
          )}

          {frame >= TC1_START && (
            <ToolCallCard
              fnName="botmem.search"
              query="pet insurance policy"
              result="Found: PetInsure Policy #PI-4821 — Nugget 🐕 (Golden Retriever) — Vet coverage AED 7,500"
              appearFrame={TC1_START}
              resultDelay={TC1_DELAY}
            />
          )}

          {/* AI response 1 — reserve height */}
          {frame >= A1_START && (
            <div style={{ minHeight: 140 }}>
              <ChatBubble variant="ai" accentColor={colors.lime}>
                <TypeWriter text={AI1} charFrames={C} startFrame={A1_START} />
              </ChatBubble>
            </div>
          )}

          {frame >= TC2_START && (
            <ToolCallCard
              fnName="botmem.search"
              query="vet report Nugget 🐕 recent"
              result="Found: Email from Valley Pet Clinic — Dr. Martinez — Nugget 🐕 checkup 03/11/2026"
              appearFrame={TC2_START}
              resultDelay={TC2_DELAY}
            />
          )}

          {/* AI response 2 — reserve height */}
          {frame >= A2_START && (
            <div style={{ minHeight: 140 }}>
              <ChatBubble variant="ai" accentColor={colors.lime}>
                <TypeWriter text={AI2} charFrames={C} startFrame={A2_START} />
              </ChatBubble>
            </div>
          )}

          {frame >= TC3_START && (
            <ToolCallCard
              fnName="botmem.search"
              query="pet insurance claims email contact"
              result="Found: claims@petinsure.com — from policy welcome email 01/15/2026"
              appearFrame={TC3_START}
              resultDelay={TC3_DELAY}
            />
          )}

          {/* AI response 3 — reserve height */}
          {frame >= A3_START && (
            <div style={{ minHeight: 140 }}>
              <ChatBubble variant="ai" accentColor={colors.lime}>
                <TypeWriter text={AI3} charFrames={C} startFrame={A3_START} />
              </ChatBubble>
            </div>
          )}

          {frame >= BADGES_START && (
            <div style={{ display: 'flex', gap: 10, paddingLeft: 4 }}>
              <div style={{ transform: `scale(${b1})`, opacity: b1 }}>
                <Badge label="POLICY FOUND" color={colors.pink} />
              </div>
              <div style={{ transform: `scale(${b2})`, opacity: b2 }}>
                <Badge label="VET REPORT" color={colors.purple} />
              </div>
              <div style={{ transform: `scale(${b3})`, opacity: b3 }}>
                <Badge label="CLAIM SENT ✓" color={colors.green} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right panel — memory results */}
      <div
        style={{
          position: 'absolute',
          top: 68,
          right: 0,
          width: 420,
          bottom: 0,
          borderLeft: `3px solid ${colors.border}`,
          background: colors.bg,
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 10px',
          gap: 16,
        }}
      >
        <div
          style={{
            padding: '0 10px',
            fontFamily: displayFont,
            fontSize: 11,
            fontWeight: 700,
            color: colors.muted,
            letterSpacing: '0.1em',
            borderBottom: `2px solid ${colors.border}`,
            paddingBottom: 10,
          }}
        >
          MEMORY RESULTS
        </div>

        {frame >= mc1Start && (
          <div
            style={{
              transform: `scale(${mc1Scale})`,
              opacity: mc1Scale,
              transformOrigin: 'top left',
            }}
          >
            <MemoryCard
              source="GMAIL"
              sourceColor={colors.pink}
              snippet={
                '"PetInsure Policy #PI-4821 — Coverage: Nugget 🐕 (Golden Retriever) — Vet visits up to AED 7,500"'
              }
              importance={92}
              fillStartFrame={mc1Start + 15}
              fillEndFrame={mc1Start + 50}
            />
          </div>
        )}

        {frame >= mc2Start && (
          <div
            style={{
              transform: `scale(${mc2Scale})`,
              opacity: mc2Scale,
              transformOrigin: 'top left',
            }}
          >
            <MemoryCard
              source="GMAIL"
              sourceColor={colors.pink}
              snippet={
                '"Valley Pet Clinic — Nugget 🐕 annual checkup — Dr. Martinez — All clear, updated vaccinations"'
              }
              importance={78}
              fillStartFrame={mc2Start + 15}
              fillEndFrame={mc2Start + 50}
            />
          </div>
        )}
      </div>

      {/* Input bar — with clear top border separator */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 420,
          padding: '14px 60px',
          background: colors.surface,
          borderTop: `3px solid ${colors.border}`,
          boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
        }}
      >
        <ChatInput isFocused />
      </div>
    </AbsoluteFill>
  );
};
