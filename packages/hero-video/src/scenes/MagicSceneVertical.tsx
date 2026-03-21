import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, SPRING_SNAPPY } from '../theme';
import { ChatBubble } from '../components/ChatBubble';
import { ChatTopbar } from '../components/ChatTopbar';
import { ChatInput } from '../components/ChatInput';
import { TypeWriter } from '../components/TypeWriter';
import { Badge } from '../components/Badge';
import { ToolCallCard } from '../components/ToolCallCard';
import { MemoryCard } from '../components/MemoryCard';

const S = 1.8; // mobile scale factor
const C = 2; // frames per character

// --- CONVERSATION TIMELINE ---
const USER1 = 'I just took Nugget \u{1F415} to the vet. Can you file an insurance claim for me?';
const U1_START = 0;
const U1_END = U1_START + USER1.length * C;

const TC1_START = U1_END + 12;
const TC1_DELAY = 30;

const AI1 =
  'Found it \u2014 you have a PetInsure policy covering vet visits up to AED 7,500. Let me pull the vet report.';
const A1_START = TC1_START + TC1_DELAY + 20;
const A1_END = A1_START + AI1.length * C;

const TC2_START = A1_END + 10;
const TC2_DELAY = 28;

const AI2 =
  'Got the report from Dr. Martinez \u2014 Nugget \u{1F415}\u2019s checkup from yesterday. Now drafting the claim email.';
const A2_START = TC2_START + TC2_DELAY + 18;
const A2_END = A2_START + AI2.length * C;

const TC3_START = A2_END + 10;
const TC3_DELAY = 25;

const AI3 =
  'Done! Sent the claim to claims@petinsure.com with your policy details, vet report, and invoice attached.';
const A3_START = TC3_START + TC3_DELAY + 18;
const A3_END = A3_START + AI3.length * C;

const BADGES_START = A3_END + 15;

const GAP = 18 * S;

export const MagicSceneVertical: React.FC = () => {
  const { colors } = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Badge springs
  const b1 = spring({ frame: Math.max(0, frame - BADGES_START), fps, config: SPRING_SNAPPY });
  const b2 = spring({ frame: Math.max(0, frame - BADGES_START - 6), fps, config: SPRING_SNAPPY });
  const b3 = spring({ frame: Math.max(0, frame - BADGES_START - 12), fps, config: SPRING_SNAPPY });

  // Memory cards appear inline after tool call results
  const mc1Start = TC1_START + TC1_DELAY;
  const mc2Start = TC2_START + TC2_DELAY;
  const mc1Scale = spring({ frame: Math.max(0, frame - mc1Start), fps, config: SPRING_SNAPPY });
  const mc2Scale = spring({ frame: Math.max(0, frame - mc2Start), fps, config: SPRING_SNAPPY });

  const PAD = 48 * S;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      {/* Topbar */}
      <ChatTopbar hasBotmem s={S} />

      {/* Chat area — full width, bottom-anchored */}
      <div
        style={{
          position: 'absolute',
          top: 68 * S,
          left: 0,
          right: 0,
          bottom: 74 * S,
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
            padding: `${24 * S}px ${PAD}px ${24 * S}px ${PAD}px`,
          }}
        >
          {/* User message */}
          {frame >= U1_START && (
            <div style={{ minHeight: 100 * S }}>
              <ChatBubble variant="user" s={S}>
                <TypeWriter text={USER1} charFrames={C} />
              </ChatBubble>
            </div>
          )}

          {/* Tool call 1 */}
          {frame >= TC1_START && (
            <ToolCallCard
              fnName="botmem.search"
              query="pet insurance policy"
              result="Found: PetInsure Policy #PI-4821 \u2014 Nugget \u{1F415} (Golden Retriever) \u2014 Vet coverage AED 7,500"
              appearFrame={TC1_START}
              resultDelay={TC1_DELAY}
              s={S}
            />
          )}

          {/* Inline memory card 1 */}
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
                  '"PetInsure Policy #PI-4821 \u2014 Coverage: Nugget \u{1F415} (Golden Retriever) \u2014 Vet visits up to AED 7,500"'
                }
                importance={92}
                fillStartFrame={mc1Start + 15}
                fillEndFrame={mc1Start + 50}
                s={S}
              />
            </div>
          )}

          {/* AI response 1 */}
          {frame >= A1_START && (
            <div style={{ minHeight: 120 * S }}>
              <ChatBubble variant="ai" accentColor={colors.lime} s={S}>
                <TypeWriter text={AI1} charFrames={C} startFrame={A1_START} />
              </ChatBubble>
            </div>
          )}

          {/* Tool call 2 */}
          {frame >= TC2_START && (
            <ToolCallCard
              fnName="botmem.search"
              query="vet report Nugget \u{1F415} recent"
              result="Found: Email from Valley Pet Clinic \u2014 Dr. Martinez \u2014 Nugget \u{1F415} checkup 03/11/2026"
              appearFrame={TC2_START}
              resultDelay={TC2_DELAY}
              s={S}
            />
          )}

          {/* Inline memory card 2 */}
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
                  '"Valley Pet Clinic \u2014 Nugget \u{1F415} annual checkup \u2014 Dr. Martinez \u2014 All clear, updated vaccinations"'
                }
                importance={78}
                fillStartFrame={mc2Start + 15}
                fillEndFrame={mc2Start + 50}
                s={S}
              />
            </div>
          )}

          {/* AI response 2 */}
          {frame >= A2_START && (
            <div style={{ minHeight: 120 * S }}>
              <ChatBubble variant="ai" accentColor={colors.lime} s={S}>
                <TypeWriter text={AI2} charFrames={C} startFrame={A2_START} />
              </ChatBubble>
            </div>
          )}

          {/* Tool call 3 */}
          {frame >= TC3_START && (
            <ToolCallCard
              fnName="botmem.search"
              query="pet insurance claims email"
              result="Found: claims@petinsure.com \u2014 from policy welcome email 01/15/2026"
              appearFrame={TC3_START}
              resultDelay={TC3_DELAY}
              s={S}
            />
          )}

          {/* AI response 3 */}
          {frame >= A3_START && (
            <div style={{ minHeight: 120 * S }}>
              <ChatBubble variant="ai" accentColor={colors.lime} s={S}>
                <TypeWriter text={AI3} charFrames={C} startFrame={A3_START} />
              </ChatBubble>
            </div>
          )}

          {/* Badges */}
          {frame >= BADGES_START && (
            <div
              style={{ display: 'flex', gap: 10 * S, paddingLeft: 4, flexWrap: 'wrap' as const }}
            >
              <div style={{ transform: `scale(${b1})`, opacity: b1 }}>
                <Badge label="POLICY FOUND" color={colors.pink} s={S} />
              </div>
              <div style={{ transform: `scale(${b2})`, opacity: b2 }}>
                <Badge label="VET REPORT" color={colors.purple} s={S} />
              </div>
              <div style={{ transform: `scale(${b3})`, opacity: b3 }}>
                <Badge label={'CLAIM SENT \u2713'} color={colors.green} s={S} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input bar — full width */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: `${14 * S}px ${PAD}px`,
          background: colors.surface,
          borderTop: `${3 * S}px solid ${colors.border}`,
          boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
        }}
      >
        <ChatInput isFocused s={S} />
      </div>
    </AbsoluteFill>
  );
};
