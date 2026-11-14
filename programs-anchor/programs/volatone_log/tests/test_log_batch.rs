// Local tests for volatone_log, run in-process with LiteSVM (no validator, no network).
// Run: cd programs-anchor && anchor build && cargo test   (or: anchor test)

use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::Instruction, solana_program::system_program,
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    volatone_log::{Action, Agent, Corridor, Entry, Kind, LogAccount, OutcomeResult, LOG_SEED},
};

fn setup() -> (LiteSVM, Keypair, Pubkey) {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/volatone_log.so"));
    svm.add_program(volatone_log::id(), bytes).unwrap();
    let worker = Keypair::new();
    svm.airdrop(&worker.pubkey(), 1_000_000_000).unwrap();
    let (log, _) = Pubkey::find_program_address(&[LOG_SEED, worker.pubkey().as_ref()], &volatone_log::id());
    (svm, worker, log)
}

fn decision(id: u32, risk_bps: u16) -> Entry {
    Entry {
        id, kind: Kind::Decision, agent: Agent::Sentinel, corridor: Corridor::UsdJpy,
        action: Action::Hedge, result: OutcomeResult::None, risk_bps, ref_id: 0,
    }
}
fn player_move(id: u32) -> Entry {
    Entry {
        id, kind: Kind::Move, agent: Agent::None, corridor: Corridor::GbpUsd,
        action: Action::Reduce, result: OutcomeResult::None, risk_bps: 0, ref_id: 0,
    }
}
fn outcome(id: u32, move_id: u32) -> Entry {
    Entry {
        id, kind: Kind::Outcome, agent: Agent::None, corridor: Corridor::None,
        action: Action::None, result: OutcomeResult::Good, risk_bps: 0, ref_id: move_id,
    }
}

/// Sends one log_batch tx. Ok(compute units used) or Err(error text).
fn send(svm: &mut LiteSVM, worker: &Keypair, log: Pubkey, entries: Vec<Entry>) -> Result<u64, String> {
    let ix = Instruction::new_with_bytes(
        volatone_log::id(),
        &volatone_log::instruction::LogBatch { entries }.data(),
        volatone_log::accounts::LogBatch { signer: worker.pubkey(), log, system_program: system_program::ID }
            .to_account_metas(None),
    );
    let msg = Message::new_with_blockhash(&[ix], Some(&worker.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[worker]).unwrap();
    let size = tx.message.serialize().len() + 1 + 64;
    let res = svm.send_transaction(tx).map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}", e.err));
    if let Ok(cu) = res { println!("  tx {size} B, {cu} CU"); }
    svm.expire_blockhash(); // next tx gets a fresh blockhash (identical txs would be rejected)
    res
}

fn read_log(svm: &LiteSVM, log: Pubkey) -> LogAccount {
    let account = svm.get_account(&log).expect("log PDA should exist");
    assert_eq!(account.owner, volatone_log::id());
    LogAccount::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[test]
fn first_call_creates_the_pda() {
    let (mut svm, worker, log) = setup();
    assert!(svm.get_account(&log).is_none(), "PDA should not exist before the first batch");

    send(&mut svm, &worker, log, vec![decision(1, 7100), player_move(2)]).unwrap();

    let state = read_log(&svm, log);
    assert_eq!((state.decisions, state.moves, state.outcomes, state.batches), (1, 1, 0, 1));
    let expected_bump = Pubkey::find_program_address(&[LOG_SEED, worker.pubkey().as_ref()], &volatone_log::id()).1;
    assert_eq!(state.bump, expected_bump);
}

#[test]
fn counters_add_up_across_two_batches() {
    let (mut svm, worker, log) = setup();

    // Batch 1: 3 decisions + 1 move.
    send(&mut svm, &worker, log, vec![decision(1, 7100), decision(2, 4800), decision(3, 6600), player_move(4)]).unwrap();
    let slot_after_first = read_log(&svm, log).last_slot;

    // Batch 2 (a full 8): 6 decisions + 1 outcome + 1 move.
    svm.warp_to_slot(slot_after_first + 10);
    let mut second: Vec<Entry> = (5..=10).map(|id| decision(id, 5000)).collect();
    second.push(outcome(11, 4));
    second.push(player_move(12));
    send(&mut svm, &worker, log, second).unwrap();

    let state = read_log(&svm, log);
    assert_eq!(state.decisions, 9);
    assert_eq!(state.moves, 2);
    assert_eq!(state.outcomes, 1);
    assert_eq!(state.batches, 2);
    assert_eq!(state.last_slot, slot_after_first + 10);
}

#[test]
fn a_batch_of_nine_is_rejected() {
    let (mut svm, worker, log) = setup();
    let nine: Vec<Entry> = (1..=9).map(|id| decision(id, 5000)).collect();

    let err = send(&mut svm, &worker, log, nine).unwrap_err();
    // TooManyEntries is the 2nd custom error: 6000 + 1.
    assert!(err.contains("Custom(6001)"), "expected TooManyEntries (6001), got {err}");
    assert!(svm.get_account(&log).is_none(), "a rejected batch must not create or change the PDA");
}

#[test]
fn empty_batch_and_bad_risk_are_rejected() {
    let (mut svm, worker, log) = setup();
    assert!(send(&mut svm, &worker, log, vec![]).unwrap_err().contains("Custom(6000)"));
    assert!(send(&mut svm, &worker, log, vec![decision(1, 10_001)]).unwrap_err().contains("Custom(6002)"));
}
