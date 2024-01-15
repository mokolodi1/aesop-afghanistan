from PhoneBuddyManager import PhoneBuddyManager
import argparse
import logging
import sys


def main():
    parser = argparse.ArgumentParser(description="Email the AESOP phone buddies if the time is right.")
    parser.add_argument("--send-emails", action='store_true', help="Actually send the emails. Without this option (by default), no emails will actually be sent although the script will perform all other actions.")
    parser.add_argument("--robot", action='store_true')
    parser.add_argument("--debug", action="store_true", help="Print debug logs (useful for finding bugs)")

    args = parser.parse_args()

    # Set up logging
    logging_level = logging.INFO
    if args.debug:
        logging_level = logging.DEBUG
    logging.basicConfig(stream=sys.stderr, level=logging_level)

    manager = PhoneBuddyManager(args.send_emails, args.robot)

    manager.manage_phone_buddy_list()

if __name__ == '__main__':
    main()
