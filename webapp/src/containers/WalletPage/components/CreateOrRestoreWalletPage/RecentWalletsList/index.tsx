import React from 'react';
import { I18n } from 'react-redux-i18n';
import styles from './RecentWalletsList.module.scss';
import { Button, ListGroup, ListGroupItem } from 'reactstrap';

interface RecentWalletsListProps {
  paths: string[];
}

const RecentWalletsList: React.FunctionComponent<RecentWalletsListProps> = (
  props: RecentWalletsListProps
) => {
  const { paths } = props;
  return (
    <ListGroup>
      {paths?.map((p, index) => {
        return (
          <ListGroupItem key={index} className={styles.listGroupItem}>
            <div>{p}</div>
            <div>
              <Button color='link' className='p-0'>
                {I18n.t('containers.wallet.restoreWalletPage.restore')}
              </Button>
            </div>
          </ListGroupItem>
        );
      })}
    </ListGroup>
  );
};

export default RecentWalletsList;
