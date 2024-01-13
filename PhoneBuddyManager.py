import datetime
import time
import click
from enum import Enum
import itertools
import logging
from Buddy import Buddy
from DatabaseConnector import DatabaseConnector
from EmailDraft import EmailDraft
from EmailSender import EmailSender
from ResultTracker import ResultTracker


ADMIN_EMAILS = None
with open("secrets/admin_emails.txt", mode="r") as admin_emails_file:
    ADMIN_EMAILS = set(itertools.chain(*[line.strip().split(",") for line in admin_emails_file.readlines()]))


class PhoneBuddyManager:
    """
    Manage the phone buddy list process and perform any necessary tasks each time it's run.
    """


    def __init__(self, really_send_emails, is_robot):
        self._really_send_emails = really_send_emails
        self._is_robot = is_robot

        self._db_connector = DatabaseConnector.get_instance()
        self._email_sender = EmailSender.get_instance()


    def give_humans_one_last_chance_to_review(self):
        click.confirm("Does the above email look good to send to everyone?")
        logging.info("Okay... well let's just make you wait for a few seconds (5) and see if you change your mind.")
        time.sleep(5)
        click.confirm('Are you still absolutely, positively sure?', abort=True, default=False)
        logging.info("Hmm, you seem quite sure of yourself, but let's wait another 5 seconds just in case.")
        time.sleep(5)
        click.confirm('Last chance to cancel! Still sure?', abort=True, default=False)
        logging.info("Okay, here we go!\n")


    def send_buddy_emails(self, buddy_pairs):
        buddy_map = self._db_connector.get_all_buddies_map()

        email_info = self._db_connector.get_email_info()

        if self._really_send_emails and not self._is_robot:
            click.confirm(
                'You are about to send %s emails to phone buddy volunteers. Are you sure you want to continue?' %
                len(buddy_pairs), abort=True, default=False)
        else:
            logging.debug("--send-emails option not passed in. Will calculate all emails to send but not actually send anything.")

        # Actually go send the emails
        first_buddy_pair = True
        for buddy_pair in buddy_pairs:
            first_buddy = buddy_map[buddy_pair[0]]
            second_buddy = buddy_map[buddy_pair[1]]
            draft = EmailDraft.draft_buddies_email(email_info, first_buddy, second_buddy)

            if first_buddy_pair:
                first_buddy_pair = False
                print("This is the first buddy pair, so we'll print a bit more info...")
                print("Draft: %s" % str(draft))
                print("Email text:")
                print("====================================")
                print(draft.contents)
                print("====================================")

                # Last check for the humans before sending the emails
                if self._really_send_emails and not self._is_robot:
                    self.give_humans_one_last_chance_to_review()

            self._email_sender.send_email(draft)


    def send_admin_reminder_emails(self):
        # TODO: check whether we recently reminded them and don't remind them if it's happened within the last 24 hours

        for email in ADMIN_EMAILS:
            draft = EmailDraft.draft_overdue_process_admin_reminder(email)

            self._email_sender.send_email(draft)


    def admin_buddy_pairs(self):
        """
        Generate a list of buddy pairs from the admin emails
        """
        # TODO: fix this if there's a different number of admins than 2
        if len(ADMIN_EMAILS) != 2:
            ResultTracker.add_issue("Different number of admins than expected")

        return ADMIN_EMAILS[:2]


    def manage_phone_buddy_list(self):
        # Read in the database to check whether there's any issues
        buddy_pairs = []
        buddies = []
        try:
            buddy_pairs = self._db_connector.get_buddy_email_pairs()
            buddies = self._db_connector.get_buddies()
        except Exception as e:
            ResultTracker.add_issue("Error fetching the database: %s" % str(e))

        # Check whether we should send out any emails and then do that
        try:
            process = self._db_connector.get_this_weeks_process()

            if process.phone_buddy_emails_sent:
                ResultTracker.set_result("Phone buddy list already sent this week.")
            elif process.admin_email_sent:
                self.send_buddy_emails(buddy_pairs)
                ResultTracker.set_result("Phone buddy list sent")
            elif process.human_process_complete:
                self.send_buddy_emails(self.admin_buddy_pairs())
                ResultTracker.set_result("Admins emailed with trial email")
            else:
                self.send_admin_reminder_emails()
                ResultTracker.set_result("Admins reminded")
        except Exception as e:
            ResultTracker.add_issue("Error checking whether to and sending emails: %s" % str(e))

        # If any issues were found, report those
        # TODO: if the result was different from the last run (and it was a robot), add a new line to the output sheet
        logging.info(ResultTracker.get_summary())
        