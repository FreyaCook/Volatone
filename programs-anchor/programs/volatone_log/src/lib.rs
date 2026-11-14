//! volatone_log: logs one batch of Volatone events (agent decisions, player moves,
//! player outcomes) per transaction, keeps running counters in a per-signer PDA, and
//! emits the entries as an Anchor event so they appear in the transaction logs.
//! No tokens, no transfers.

use anchor_lang::prelude::*;

declare_id!("2jHECa8gr3VFYTuBvRxmB4BtX3DasybJFKixp5348HeN");

/// Same cap as the backend batcher (MAX_PER_TX).
pub const MAX_ENTRIES: usize = 8;
pub const LOG_SEED: &[u8] = b"log";

#[program]
pub mod volatone_log {
    use super::*;

    pub fn log_batch(ctx: Context<LogBatch>, entries: Vec<Entry>) -> Result<()> {
        require!(!entries.is_empty(), LogError::EmptyBatch);
        require!(entries.len() <= MAX_ENTRIES, LogError::TooManyEntries);

        let log = &mut ctx.accounts.log;
        for e in &entries {
            require!(e.risk_bps <= 10_000, LogError::RiskOutOfRange);
            match e.kind {
                Kind::Decision => log.decisions += 1,
                Kind::Move => log.moves += 1,
                Kind::Outcome => log.outcomes += 1,
            }
        }
        let slot = Clock::get()?.slot;
        log.batches += 1;
        log.last_slot = slot;
        log.bump = ctx.bumps.log;

        msg!("volatone: batch {} with {} entries", log.batches, entries.len());
        emit!(BatchLogged { signer: ctx.accounts.signer.key(), slot, entries });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct LogBatch<'info> {
    /// The worker wallet. Pays for the PDA on first use.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + LogAccount::INIT_SPACE,
        seeds = [LOG_SEED, signer.key().as_ref()],
        bump
    )]
    pub log: Account<'info, LogAccount>,
    pub system_program: Program<'info, System>,
}

/// Running counters for one signer.
#[account]
#[derive(InitSpace)]
pub struct LogAccount {
    pub decisions: u64,
    pub moves: u64,
    pub outcomes: u64,
    pub batches: u64,
    pub last_slot: u64,
    pub bump: u8,
}

/// One compact event record (15 bytes). Fields that don't apply to a kind are None / 0.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// Numeric part of the event id: "evt_0042" -> 42.
    pub id: u32,
    pub kind: Kind,
    pub agent: Agent,
    pub corridor: Corridor,
    pub action: Action,
    /// Outcomes only (Good/Poor); None otherwise.
    pub result: OutcomeResult,
    /// Agent's risk score in basis points (0..=10000); 0 for moves and outcomes.
    pub risk_bps: u16,
    /// Outcomes only: numeric id of the player_move judged. 0 otherwise.
    pub ref_id: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum Kind { Decision, Move, Outcome }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum Agent { None, Sentinel, Opportunist, Strategist }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum Corridor { None, UsdJpy, EurJpy, EurUsd, GbpUsd }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum Action { None, Hedge, Hold, Reduce }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum OutcomeResult { None, Good, Poor }

#[event]
pub struct BatchLogged {
    pub signer: Pubkey,
    pub slot: u64,
    pub entries: Vec<Entry>,
}

#[error_code]
pub enum LogError {
    #[msg("Batch has no entries")]
    EmptyBatch,
    #[msg("Batch has more than 8 entries")]
    TooManyEntries,
    #[msg("risk_bps must be 0..=10000")]
    RiskOutOfRange,
}
